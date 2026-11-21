import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { ExpenseSubmissionService } from '../expenses/expense-submission.service';
import { PrismaService } from '../prisma/prisma.service';
import { settledTransactionSchema } from './dto/card-event.dto';

/** What happened to one event. Returned so tests can assert without polling. */
export type ProcessOutcome = 'PROCESSED' | 'RETRY' | 'FAILED';

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly expenseId?: string;
  readonly reason?: string;
}

/**
 * Turning one accepted event into one expense (F12).
 *
 * =============================================================================
 * THIS FILE CONTAINS NO BUSINESS RULES, AND THAT IS THE DESIGN
 * =============================================================================
 *
 * The assessment says a card transaction "should become an expense that goes
 * through the same policy rules". Not equivalent rules - the SAME ones. So
 * this calls `ExpenseSubmissionService.submit`, the identical entry point a
 * company's own backend reaches through `POST /v1/expenses`.
 *
 * It therefore inherits, with no new code and no second implementation:
 *
 *   - the transaction-scoped advisory lock that makes the frequency count
 *     correct under concurrency (ADR-007)
 *   - the unique constraint that makes submission idempotent (ADR-001)
 *   - amount limit, frequency and blocked category, with REJECT > REVIEW >
 *     APPROVE and every reason recorded
 *   - the policy snapshot, so the decision stays explainable
 *   - review creation for a REVIEW decision, and only for one
 *   - tenant-scoped persistence
 *
 * A separate "webhook policy engine" would be a second place for those rules
 * to drift, and the drift would be invisible: both would look right in
 * isolation and disagree about one expense in a thousand.
 *
 * =============================================================================
 * AT-LEAST-ONCE PROCESSING, WITH IDEMPOTENT EFFECTS
 * =============================================================================
 *
 * Exactly-once delivery over a network does not exist, and this does not claim
 * it. What is claimed is narrower and true: an event may be PROCESSED more
 * than once, and the business effect happens once.
 *
 * The window that makes this matter is real. A worker claims an event, the
 * expense transaction COMMITS, and the process dies before the event row is
 * marked processed. The lease expires, another attempt claims the same event,
 * and `submit` finds the existing expense by `(companyId, source, externalId)`
 * and returns it with `duplicate: true` - the original decision, no second
 * rule hit, no second review, and nothing added to a future frequency window.
 * The event then reaches its terminal state, late but correct (F12-T31).
 */
@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly submission: ExpenseSubmissionService,
    @Inject(ENV) env: Env,
  ) {
    this.maxAttempts = env.WEBHOOK_MAX_ATTEMPTS;
  }

  /**
   * Processes one CLAIMED event and writes its terminal or retry state.
   *
   * The caller has already incremented `attempts` as part of claiming, so a
   * crash between the claim and here still counts against the bound. An
   * attempt counter incremented at the END would never advance for an event
   * that crashes the worker every time, and it would be retried forever.
   */
  async process(event: WebhookEvent): Promise<ProcessResult> {
    const parsed = settledTransactionSchema.safeParse(event.payload);

    if (!parsed.success) {
      // Stored payloads were validated at intake, so this means the row was
      // written by something else or the schema changed underneath it.
      // Permanent either way: retrying cannot make it parse.
      return this.fail(event, 'The stored payload no longer matches the event schema.');
    }

    const data = parsed.data;

    try {
      const result = await this.submission.submit(
        event.companyId,
        {
          // The one place the provider's vocabulary becomes ours.
          externalId: data.transactionId,
          employeeId: data.cardholderId,
          amount: data.amount,
          currency: data.currency,
          merchant: data.merchant,
          category: data.category,
          spentAt: data.spentAt,
        },
        'CARD_WEBHOOK',
      );

      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          expenseId: result.expense.id,
          claimedAt: null,
          lastError: null,
        },
      });

      return { outcome: 'PROCESSED', expenseId: result.expense.id };
    } catch (error) {
      return this.classify(event, error);
    }
  }

  /**
   * Decides whether a failure is worth repeating.
   *
   * ---------------------------------------------------------------------
   * THE DIVIDING LINE: WOULD THE SAME REQUEST SUCCEED LATER?
   * ---------------------------------------------------------------------
   *
   * PERMANENT - a 4xx from the submission service. The event is in a currency
   * this company does not use, or its `spentAt` is outside the 90-day window,
   * or its transaction id already names a different expense. Every one of
   * those is a property of the event itself, and the hundredth attempt will
   * be refused for exactly the reason the first was. Retrying is noise that
   * hides the real failures.
   *
   * TRANSIENT - anything else. A dropped connection, a deadlock, a restart
   * mid-flight. The event is fine; the moment was not.
   *
   * The test is the HTTP status the service chose, which is already a
   * deliberate statement about whose fault the failure is - 4xx means the
   * input, 5xx means us. Reusing it avoids a second classification that could
   * disagree with the first.
   */
  private async classify(event: WebhookEvent, error: unknown): Promise<ProcessResult> {
    const permanent = error instanceof HttpException && error.getStatus() < 500;

    if (permanent) {
      return this.fail(event, sanitise(error));
    }

    if (event.attempts >= this.maxAttempts) {
      this.logger.warn(
        `Webhook event ${event.id} gave up after ${event.attempts} attempts.`,
      );

      return this.fail(
        event,
        `Gave up after ${event.attempts} attempts. Last problem: ${sanitise(error)}`,
      );
    }

    const delayMs = backoffMs(event.attempts);

    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'PENDING',
        claimedAt: null,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: sanitise(error),
      },
    });

    return { outcome: 'RETRY', reason: sanitise(error) };
  }

  private async fail(event: WebhookEvent, reason: string): Promise<ProcessResult> {
    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        claimedAt: null,
        processedAt: new Date(),
        lastError: reason,
      },
    });

    return { outcome: 'FAILED', reason };
  }
}

/**
 * Exponential backoff, in a column rather than in a sleep.
 *
 * 2s, 4s, 8s, 16s, 32s, capped at five minutes. A fixed delay would retry a
 * thousand stuck events against a database that is already struggling - which
 * is how a brief outage becomes a long one.
 *
 * There is no jitter, and that is a real limitation rather than an oversight:
 * with one worker and a small inbox the herd this would spread does not
 * exist. It is written down in the README.
 */
function backoffMs(attempts: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/**
 * A reason safe to store and to render in a browser.
 *
 * Raw exception text carries connection strings, query parameters and
 * occasionally credentials, and `lastError` is shown to an administrator. So
 * only the API's OWN error contract is quoted - the `message` a controller
 * deliberately wrote for a caller - and anything else becomes a flat string
 * naming its class and nothing more.
 */
function sanitise(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();

    if (typeof body === 'object' && body !== null) {
      const shaped = body as { error?: unknown; message?: unknown };
      const code = typeof shaped.error === 'string' ? shaped.error : 'error';
      const message = typeof shaped.message === 'string' ? shaped.message : '';

      return message ? `${code}: ${message}`.slice(0, 500) : code;
    }

    return `http_${error.getStatus()}`;
  }

  return error instanceof Error ? `internal_error (${error.name})` : 'internal_error';
}
