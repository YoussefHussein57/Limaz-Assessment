import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { ExpenseSubmissionService } from '../../src/expenses/expense-submission.service';
import { asUser, login } from '../admin/f08-test-app';
import { resetDatabase } from '../test-db';
import { cardEvent, deliver } from './webhook-client';
import { createF12TestApp, type F12TestApp } from './f12-test-app';

/**
 * F12 - asynchronous processing, retries, and crash recovery.
 *
 * The worker is OFF in this harness and driven one event at a time, so every
 * assertion here is about something the test caused rather than something it
 * waited for. A suite that sleeps is a suite that passes for the wrong reason
 * on a slow machine (the F04 lesson, applied to a queue).
 */
describe('F12 webhook worker', () => {
  let booted: F12TestApp;
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;

  let adminCookie: string;
  let deliveryId: string;
  let secret: string;

  /** Company B, for the "another company's events are independent" cases. */
  let otherDeliveryId: string;
  let otherSecret: string;

  beforeAll(async () => {
    // Two attempts, and the shortest lease the schema allows, so the retry
    // bound and the crash-recovery window are both reachable by backdating
    // `claimedAt` rather than by waiting.
    booted = await createF12TestApp({ maxAttempts: 2, claimLeaseSeconds: 5 });
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);

    const a = await provision(COMPANY_A.id);
    deliveryId = a.deliveryId;
    secret = a.secret;

    const b = await provision(COMPANY_B.id);
    otherDeliveryId = b.deliveryId;
    otherSecret = b.secret;
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await booted?.app.close();
  });

  async function provision(companyId: string) {
    const response = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/webhook-integration`)
      .set(asUser(adminCookie))
      .expect(200);

    return {
      deliveryId: response.body.integration.deliveryId,
      secret: response.body.signingSecret,
    };
  }

  const send = (event: unknown) => deliver(app, deliveryId, secret, event);

  /** Delivers an event and returns its internal id. */
  async function accept(event: Record<string, unknown>): Promise<string> {
    const response = await send(event).expect(202);

    return response.body.eventId as string;
  }

  const row = (id: string) => prisma.webhookEvent.findUniqueOrThrow({ where: { id } });

  // ===========================================================================
  // The happy path, one claim at a time
  // ===========================================================================

  it('F12-T60: a pending event becomes an expense when a worker claims it', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_w_1', amount: 12_500 }));

    expect((await row(id)).status).toBe('PENDING');

    const result = await booted.worker.drainOne();

    expect(result?.outcome).toBe('PROCESSED');

    const after = await row(id);

    expect(after.status).toBe('PROCESSED');
    expect(after.attempts).toBe(1);
    expect(after.processedAt).not.toBeNull();
    expect(after.claimedAt).toBeNull();
    expect(after.expenseId).not.toBeNull();

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: after.expenseId! } });

    expect(expense.externalId).toBe('txn_w_1');
    expect(expense.source).toBe('CARD_WEBHOOK');
    expect(expense.companyId).toBe(COMPANY_A.id);
    // Nile's limit is 500.00 SAR, so 125.00 is under it.
    expect(expense.decision).toBe('APPROVE');
    expect(expense.status).toBe('APPROVED');
  });

  it('F12-T61: draining an empty inbox does nothing', async () => {
    await drain();

    expect(await booted.worker.drainOne()).toBeNull();
  });

  it('F12-T62: the worker claims the oldest due event first', async () => {
    const first = await accept(cardEvent({ transactionId: 'txn_order_1' }));
    const second = await accept(cardEvent({ transactionId: 'txn_order_2' }));

    const a = await booted.worker.drainOne();
    const b = await booted.worker.drainOne();

    expect(a?.outcome).toBe('PROCESSED');
    expect(b?.outcome).toBe('PROCESSED');

    const firstRow = await row(first);
    const secondRow = await row(second);

    expect(firstRow.processedAt!.getTime()).toBeLessThanOrEqual(secondRow.processedAt!.getTime());
  });

  // ===========================================================================
  // The policy engine is the SAME one
  // ===========================================================================

  it('F12-T63: an amount over the limit opens exactly one review', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_review_1', amount: 88_800 }));

    await booted.worker.drainOne();

    const expense = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'txn_review_1', source: 'CARD_WEBHOOK' },
      include: { ruleHits: true, review: true },
    });

    expect(expense.decision).toBe('REVIEW');
    expect(expense.status).toBe('PENDING_REVIEW');
    expect(expense.ruleHits.map((h) => h.ruleCode)).toEqual(['AMOUNT_LIMIT']);
    expect(expense.review).not.toBeNull();
    expect(expense.review!.state).toBe('OPEN');

    // The policy snapshot is captured, so "why was this flagged?" stays
    // answerable after the policy changes.
    expect(expense.policySnapshot).toMatchObject({ autoApproveLimitMinor: 50_000 });

    expect((await row(id)).status).toBe('PROCESSED');
  });

  it('F12-T64: a blocked category is REJECTED and opens NO review', async () => {
    await accept(cardEvent({ transactionId: 'txn_reject_1', category: 'GAMBLING' }));

    await booted.worker.drainOne();

    const expense = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'txn_reject_1', source: 'CARD_WEBHOOK' },
      include: { ruleHits: true, review: true },
    });

    expect(expense.decision).toBe('REJECT');
    expect(expense.status).toBe('REJECTED');
    // A8: a review exists only for a REVIEW decision.
    expect(expense.review).toBeNull();
  });

  it('F12-T65: two rules firing give REJECT, with both reasons kept', async () => {
    await accept(
      cardEvent({ transactionId: 'txn_both_1', category: 'GAMBLING', amount: 99_000 }),
    );

    await booted.worker.drainOne();

    const expense = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'txn_both_1', source: 'CARD_WEBHOOK' },
      include: { ruleHits: true },
    });

    // REJECT > REVIEW > APPROVE, and no reason is discarded.
    expect(expense.decision).toBe('REJECT');
    expect(expense.ruleHits.map((h) => h.ruleCode).sort()).toEqual([
      'AMOUNT_LIMIT',
      'BLOCKED_CATEGORY',
    ]);
  });

  it('F12-T66: the frequency rule counts webhook expenses like any other', async () => {
    const employee = `emp-freq-${Date.now().toString(36)}`;
    const base = Date.now() - 30 * 60_000;

    // Nile allows 3 in 60 minutes. The fourth is the one that trips it.
    for (let index = 0; index < 4; index += 1) {
      await accept(
        cardEvent({
          transactionId: `txn_freq_${index}`,
          cardholderId: employee,
          amount: 1_000,
          spentAt: new Date(base + index * 60_000).toISOString(),
        }),
      );

      // Processed one at a time, so each sees its predecessors committed.
      await booted.worker.drainOne();
    }

    const expenses = await prisma.expense.findMany({
      where: { employeeId: employee },
      include: { ruleHits: true },
      orderBy: { spentAt: 'asc' },
    });

    expect(expenses).toHaveLength(4);
    expect(expenses.slice(0, 3).every((e) => e.decision === 'APPROVE')).toBe(true);
    expect(expenses[3]!.decision).toBe('REVIEW');
    expect(expenses[3]!.ruleHits.map((h) => h.ruleCode)).toEqual(['FREQUENCY']);
  });

  it('F12-T67: a webhook expense and an identical API expense agree', async () => {
    const employee = `emp-compare-${Date.now().toString(36)}`;
    const spentAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const apiKey = 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s';

    await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'cmp-api-1',
        employeeId: employee,
        amount: 77_000,
        currency: 'SAR',
        merchant: 'Comparison Ltd',
        category: 'OFFICE',
        spentAt,
      })
      .expect(201);

    await accept(
      cardEvent({
        transactionId: 'cmp-wh-1',
        cardholderId: `${employee}-wh`,
        amount: 77_000,
        merchant: 'Comparison Ltd',
        category: 'OFFICE',
        spentAt,
      }),
    );

    await booted.worker.drainOne();

    const viaApi = await prisma.expense.findFirstOrThrow({ where: { externalId: 'cmp-api-1' } });
    const viaWebhook = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'cmp-wh-1' },
    });

    // Different employees, so the frequency rule cannot make them differ -
    // what is being compared is the decision for identical facts.
    expect(viaWebhook.decision).toBe(viaApi.decision);
    expect(viaWebhook.status).toBe(viaApi.status);
    expect(viaWebhook.policySnapshot).toEqual(viaApi.policySnapshot);
    // The ONLY difference is where it came from.
    expect(viaApi.source).toBe('API');
    expect(viaWebhook.source).toBe('CARD_WEBHOOK');
  });

  // ===========================================================================
  // Expense idempotency, underneath event deduplication
  // ===========================================================================

  it('F12-T70: processing the same event twice creates one expense', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_twice_1' }));

    await booted.worker.drainOne();

    const first = await row(id);
    const ruleHitsAfterFirst = await prisma.ruleHit.count({
      where: { expenseId: first.expenseId! },
    });

    // Force it back to PENDING - the shape a crashed worker's event recovers
    // into - and let a worker take it again.
    await prisma.webhookEvent.update({
      where: { id },
      data: { status: 'PENDING', nextAttemptAt: new Date(), processedAt: null },
    });

    const second = await booted.worker.drainOne();

    expect(second?.outcome).toBe('PROCESSED');

    const after = await row(id);

    // The SAME expense. `submit` found it by (companyId, source, externalId)
    // and returned the original decision.
    expect(after.expenseId).toBe(first.expenseId);
    expect(await prisma.expense.count({ where: { externalId: 'txn_twice_1' } })).toBe(1);
    // No SECOND set of rule hits, whatever the first evaluation produced.
    expect(await prisma.ruleHit.count({ where: { expenseId: first.expenseId! } })).toBe(
      ruleHitsAfterFirst,
    );
  });

  it('F12-T71: a worker that commits an expense and then dies recovers correctly', async () => {
    // THE failure window the assessment's bonus is really about.
    //
    //   1. a worker claims the event
    //   2. the expense transaction COMMITS
    //   3. the process dies before the event row is marked processed
    //   4. the lease expires and another attempt claims it
    //   5. idempotency returns the original expense
    //   6. the event reaches its terminal state, late but correct
    const id = await accept(cardEvent({ transactionId: 'txn_crash_1', amount: 88_800 }));

    // Step 1-2 for real: process it, so the expense genuinely exists.
    await booted.worker.drainOne();

    const processed = await row(id);
    const expenseId = processed.expenseId!;

    expect(expenseId).not.toBeNull();

    // Step 3: the crash. The row is left exactly as a killed worker leaves
    // it - claimed, PROCESSING, nothing written about the expense.
    await prisma.webhookEvent.update({
      where: { id },
      data: {
        status: 'PROCESSING',
        claimedAt: new Date(Date.now() - 60_000),
        processedAt: null,
        expenseId: null,
      },
    });

    // Step 4: `claimedAt` is a minute ago and the lease is five seconds, so
    // this claim is recoverable.
    const recovered = await booted.worker.drainOne();

    expect(recovered?.outcome).toBe('PROCESSED');

    const after = await row(id);

    // Steps 5-6.
    expect(after.status).toBe('PROCESSED');
    expect(after.expenseId).toBe(expenseId);
    expect(after.attempts).toBe(2);

    // And the business effects happened exactly once.
    expect(await prisma.expense.count({ where: { externalId: 'txn_crash_1' } })).toBe(1);

    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: expenseId },
      include: { ruleHits: true, review: true },
    });

    expect(expense.ruleHits).toHaveLength(1);
    expect(expense.review).not.toBeNull();
    // The original decision was not rewritten.
    expect(expense.decision).toBe('REVIEW');
  });

  it('F12-T72: an abandoned claim is not stolen while its lease is alive', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_lease_1' }));

    // Claimed a moment ago by a worker that is still alive.
    await prisma.webhookEvent.update({
      where: { id },
      data: { status: 'PROCESSING', claimedAt: new Date() },
    });

    expect(await booted.worker.drainOne()).toBeNull();

    // Now the lease has expired.
    await prisma.webhookEvent.update({
      where: { id },
      data: { claimedAt: new Date(Date.now() - 10_000) },
    });

    expect((await booted.worker.drainOne())?.outcome).toBe('PROCESSED');
  });

  it('F12-T73: two workers claiming at the same moment do not get the same event', async () => {
    await drain();

    const ids = await Promise.all([
      accept(cardEvent({ transactionId: 'txn_claim_1' })),
      accept(cardEvent({ transactionId: 'txn_claim_2' })),
    ]);

    // Genuinely overlapping claims on a pool of 10 connections.
    const [a, b] = await Promise.all([booted.worker.drainOne(), booted.worker.drainOne()]);

    expect([a?.outcome, b?.outcome].sort()).toEqual(['PROCESSED', 'PROCESSED']);

    const rows = await prisma.webhookEvent.findMany({ where: { id: { in: ids } } });

    // Each claimed exactly once. `FOR UPDATE SKIP LOCKED` is what makes this
    // true; a SELECT-then-UPDATE would let both workers take the same row and
    // one of these counters would read 2.
    expect(rows.map((r) => r.attempts)).toEqual([1, 1]);
    expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect(new Set(rows.map((r) => r.expenseId)).size).toBe(2);
  });

  // ===========================================================================
  // Failure classification
  // ===========================================================================

  it('F12-T80: a permanently invalid event fails terminally on the first attempt', async () => {
    // A currency this company does not use: a 422 from the submission
    // service, and a property of the event rather than of the moment. The
    // hundredth attempt would be refused for the same reason as the first.
    const id = await accept(
      cardEvent({ transactionId: 'txn_bad_currency', currency: 'USD' }),
    );

    const result = await booted.worker.drainOne();

    expect(result?.outcome).toBe('FAILED');

    const after = await row(id);

    expect(after.status).toBe('FAILED');
    expect(after.attempts).toBe(1);
    expect(after.expenseId).toBeNull();
    expect(after.lastError).toContain('currency_mismatch');
    // Sanitised: the API's own message, not a stack trace or a query.
    expect(after.lastError).not.toContain('at ');
    expect(after.lastError).not.toContain('postgresql://');
  });

  it('F12-T80b: a terminal event is never claimed again', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_bad_2', currency: 'EUR' }));

    await booted.worker.drainOne();
    expect((await row(id)).status).toBe('FAILED');

    await drain();

    expect((await row(id)).attempts).toBe(1);
  });

  it('F12-T81: a transient failure is retried, and bounded', async () => {
    const id = await accept(cardEvent({ transactionId: 'txn_retry_1' }));

    // A transient fault, injected into the one dependency the processor has.
    const submit = jest
      .spyOn(booted.app.get(ExpenseSubmissionService), 'submit')
      .mockRejectedValue(new Error('connection terminated unexpectedly'));

    try {
      const first = await booted.worker.drainOne();

      expect(first?.outcome).toBe('RETRY');

      const afterFirst = await row(id);

      expect(afterFirst.status).toBe('PENDING');
      expect(afterFirst.attempts).toBe(1);
      expect(afterFirst.claimedAt).toBeNull();
      // Backoff lives in the column, not in a sleep.
      expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      // Nothing internal leaked into a field an administrator reads.
      expect(afterFirst.lastError).toBe('internal_error (Error)');

      // Make it due again and let it reach the bound (maxAttempts is 2 here).
      await prisma.webhookEvent.update({
        where: { id },
        data: { nextAttemptAt: new Date() },
      });

      const second = await booted.worker.drainOne();

      expect(second?.outcome).toBe('FAILED');

      const afterSecond = await row(id);

      expect(afterSecond.status).toBe('FAILED');
      expect(afterSecond.attempts).toBe(2);
      expect(afterSecond.lastError).toContain('Gave up after 2 attempts');
    } finally {
      submit.mockRestore();
    }
  });

  it('F12-T82: an ignored event is never processed', async () => {
    const response = await send(
      cardEvent({ id: 'evt_ignored_w', type: 'transaction.reversed' }),
    ).expect(202);

    expect(response.body.status).toBe('IGNORED');

    await drain();

    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: response.body.eventId },
    });

    expect(stored.status).toBe('IGNORED');
    expect(stored.attempts).toBe(0);
    expect(stored.expenseId).toBeNull();
  });

  // ===========================================================================
  // Tenancy, after processing
  // ===========================================================================

  it('F12-T90: an event is processed into the company it authenticated as', async () => {
    await deliver(
      app,
      otherDeliveryId,
      otherSecret,
      cardEvent({ transactionId: 'txn_tenant_b', amount: 5_000 }),
    ).expect(202);

    await drain();

    const expense = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'txn_tenant_b', source: 'CARD_WEBHOOK' },
    });

    expect(expense.companyId).toBe(COMPANY_B.id);

    // Delta's manager sees it; Nile's does not.
    const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
    const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;

    const deltaCookie = await login(app, deltaManager.email, deltaManager.password);
    const nileCookie = await login(app, nileManager.email, nileManager.password);

    await request(app.getHttpServer())
      .get(`/v1/expenses/${expense.id}`)
      .set(asUser(deltaCookie))
      .expect(200);

    // 404, not 403: at the row layer a 403 would confirm the id exists.
    await request(app.getHttpServer())
      .get(`/v1/expenses/${expense.id}`)
      .set(asUser(nileCookie))
      .expect(404);
  });

  it('F12-T91: an ordinary caller cannot collide with a webhook expense', async () => {
    // Both namespaces hold the same identifier, and they are two different
    // expenses. A reserved prefix could not have achieved this, because an
    // ordinary client picks the whole externalId itself.
    const shared = 'txn_namespace_1';

    await accept(cardEvent({ transactionId: shared, amount: 3_000 }));
    await drain();

    await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s')
      .send({
        externalId: shared,
        employeeId: 'emp-api',
        amount: 4_000,
        currency: 'SAR',
        merchant: 'Direct',
        category: 'OFFICE',
        spentAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(201);

    const both = await prisma.expense.findMany({
      where: { companyId: COMPANY_A.id, externalId: shared },
      orderBy: { source: 'asc' },
    });

    expect(both).toHaveLength(2);
    expect(both.map((e) => e.source)).toEqual(['API', 'CARD_WEBHOOK']);
    expect(both.map((e) => e.amountMinor)).toEqual([4_000, 3_000]);
  });

  it('F12-T92: an ordinary caller still cannot duplicate its OWN externalId', async () => {
    // The guarantee the assessment actually asks for is unchanged by adding
    // the source to the key.
    const body = {
      externalId: 'txn_namespace_2',
      employeeId: 'emp-api',
      amount: 4_000,
      currency: 'SAR',
      merchant: 'Direct',
      category: 'OFFICE',
      spentAt: new Date(Date.now() - 60_000).toISOString(),
    };

    await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s')
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s')
      .send({ ...body, amount: 9_999 })
      .expect(409);

    expect(
      await prisma.expense.count({
        where: { companyId: COMPANY_A.id, externalId: 'txn_namespace_2', source: 'API' },
      }),
    ).toBe(1);
  });

  // ===========================================================================
  // The manager resolves what a webhook produced
  // ===========================================================================

  it('F12-T95: a manager resolves a webhook-originated review normally', async () => {
    await accept(cardEvent({ transactionId: 'txn_resolve_1', amount: 95_000 }));
    await drain();

    const expense = await prisma.expense.findFirstOrThrow({
      where: { externalId: 'txn_resolve_1', source: 'CARD_WEBHOOK' },
      include: { review: true },
    });

    const manager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
    const cookie = await login(app, manager.email, manager.password);

    await request(app.getHttpServer())
      .post(`/v1/reviews/${expense.review!.id}/resolve`)
      .set(asUser(cookie))
      .send({ decision: 'APPROVE' })
      .expect(200);

    const resolved = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      include: { review: true },
    });

    expect(resolved.status).toBe('APPROVED');
    // The automated decision is history.
    expect(resolved.decision).toBe('REVIEW');
    expect(resolved.review!.state).toBe('RESOLVED');
    expect(resolved.review!.resolvedByUserId).toBe(
      (await prisma.user.findUniqueOrThrow({ where: { email: manager.email } })).id,
    );
  });

  /** Drains everything currently due. Bounded, so a bug cannot hang the suite. */
  async function drain(limit = 50): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      if ((await booted.worker.drainOne()) === null) {
        return;
      }
    }

    throw new Error(`the inbox did not drain within ${limit} events`);
  }
});
