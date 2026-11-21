import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookProcessorService, type ProcessResult } from './webhook-processor.service';

/** How many events one tick will drain before yielding. */
const BATCH_SIZE = 20;

/**
 * The background worker that drains the webhook inbox (F12).
 *
 * =============================================================================
 * WHY POSTGRESQL AND NOT BULLMQ, WHICH THE ASSESSMENT OFFERS
 * =============================================================================
 *
 * The assessment names BullMQ as "one option", and it is a good one - but it
 * is Redis, and Redis is a second stateful service in a deployment whose
 * entire promise is one `docker compose up`. The queue would also be a second
 * place where an accepted event can exist, which raises the question this
 * design exists to avoid: what is true if the row committed and the enqueue
 * did not?
 *
 * Here there is one store. "Accepted" and "queued" are the same fact, written
 * once, in the transaction that answers the provider. There is no window in
 * which they can disagree.
 *
 * The costs are real and are written down rather than glossed:
 *
 *   - POLLING, not push. An idle worker wakes every
 *     `WEBHOOK_POLL_INTERVAL_MS` and asks. At this volume that is nothing; at
 *     thousands of events a second it would not be the right answer.
 *   - The database does two jobs. Queue traffic competes with query traffic
 *     for the same connections.
 *   - No scheduling features. No priorities, no delayed jobs beyond
 *     `nextAttemptAt`, no dead-letter queue beyond `status = FAILED`.
 *
 * =============================================================================
 * HOW TWO WORKERS CANNOT CLAIM ONE EVENT
 * =============================================================================
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select. The row is locked by the
 * SELECT, the surrounding UPDATE changes its status in the SAME statement,
 * and a competitor's `SKIP LOCKED` steps over the locked row rather than
 * waiting for it. Both workers make progress; neither gets the same event.
 *
 * The alternative - SELECT, then UPDATE - is the read-then-write race that
 * F04 exists to teach: both workers read the same PENDING row, both update
 * it, and the event is processed twice. The expense would still be correct,
 * because submission is idempotent, but the work would be doubled and the
 * attempt counter would be wrong.
 *
 * A transaction-scoped advisory lock would also work, and is what F04 uses -
 * but that serialises every claim through one lock, and claiming is exactly
 * the operation that should be parallel.
 *
 * =============================================================================
 * HOW A CRASHED WORKER'S EVENT COMES BACK
 * =============================================================================
 *
 * The claim writes `claimedAt`. The claim query's second branch matches rows
 * that are still PROCESSING with a `claimedAt` older than
 * `WEBHOOK_CLAIM_LEASE_SECONDS`, which can only be true if the worker holding
 * them stopped. There is no heartbeat and no distributed lock: the lease is a
 * timestamp, and expiry is a comparison.
 */
@Injectable()
export class WebhookWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebhookWorkerService.name);

  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseSeconds: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: WebhookProcessorService,
    @Inject(ENV) env: Env,
  ) {
    this.enabled = env.WEBHOOK_WORKER_ENABLED;
    this.pollIntervalMs = env.WEBHOOK_POLL_INTERVAL_MS;
    this.leaseSeconds = env.WEBHOOK_CLAIM_LEASE_SECONDS;
  }

  /**
   * `OnApplicationBootstrap`, not `OnModuleInit`.
   *
   * The second fires while other modules are still initialising, so the
   * worker could claim and process an event before the application is
   * assembled. The first fires once everything is ready.
   */
  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Webhook worker disabled by configuration.');
      return;
    }

    this.schedule();
  }

  /**
   * Stops cleanly on SIGTERM.
   *
   * An event claimed but not finished when this fires is simply left
   * PROCESSING: its lease expires and the next process takes it. There is no
   * attempt to "release" claims on the way out, because a worker that is
   * being killed cannot be relied on to run that code - the recovery path has
   * to work without it, so it is the only path.
   */
  onModuleDestroy(): void {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      // `catch` BEFORE `finally`, and this is not defensive decoration.
      //
      // `tick()` claims rows with raw SQL. A malformed query rejects, and a
      // rejection from inside a timer has nobody waiting on it: Node treats
      // an unhandled rejection as fatal and **the whole API process exits**.
      // That is how a typo in the claim query took the service down, health
      // check and all, with the stack trace buried under a container restart
      // loop (AI_LOG 55).
      //
      // A background worker must never be able to stop the application. It
      // logs, skips this tick, and tries again on the next one.
      void this.tick()
        .catch((error: unknown) => {
          this.logger.error(
            'Webhook worker tick failed; the next tick will retry.',
            error instanceof Error ? error.stack : String(error),
          );
        })
        .finally(() => this.schedule());
    }, this.pollIntervalMs);

    // Do not hold the process open for a poll. Without this a `docker stop`
    // waits out the interval before the container exits.
    this.timer.unref?.();
  }

  /**
   * Drains up to `BATCH_SIZE` events, then yields.
   *
   * Bounded so one burst cannot occupy the worker indefinitely while newer
   * events with an earlier `nextAttemptAt` wait behind it.
   */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;

    try {
      let handled = 0;

      while (handled < BATCH_SIZE && !this.stopped) {
        const claimed = await this.claimOne();

        if (!claimed) {
          break;
        }

        await this.processClaimed(claimed);
        handled += 1;
      }

      return handled;
    } finally {
      this.running = false;
    }
  }

  /** Claims and processes exactly one event. Used by the tests directly. */
  async drainOne(): Promise<ProcessResult | null> {
    const claimed = await this.claimOne();

    return claimed ? this.processClaimed(claimed) : null;
  }

  private async processClaimed(event: WebhookEvent): Promise<ProcessResult> {
    try {
      return await this.processor.process(event);
    } catch (error) {
      // The processor writes its own terminal state, so reaching here means
      // the write itself failed. The event stays PROCESSING and its lease
      // expires - which is the crash-recovery path, exercised deliberately.
      this.logger.error(
        `Webhook event ${event.id} left claimed after a processing failure.`,
        error instanceof Error ? error.stack : undefined,
      );

      return { outcome: 'RETRY', reason: 'internal_error' };
    }
  }

  /**
   * Takes the oldest due event, or reclaims one whose lease has expired.
   *
   * Raw SQL because `FOR UPDATE SKIP LOCKED` has no Prisma equivalent, and
   * the alternative - a read followed by a conditional update - is the race
   * this is written to avoid.
   *
   * `attempts` is incremented HERE, as part of claiming. An event that
   * crashes the worker every time still advances towards its bound; counting
   * on completion would retry it forever.
   */
  private async claimOne(): Promise<WebhookEvent | null> {
    // The column names are CAMEL CASE and quoted, because the Prisma model
    // maps only the TABLE (`@@map("webhook_events")`) and not its fields. A
    // first attempt wrote them in snake_case out of habit, which PostgreSQL
    // answered with `column "next_attempt_at" does not exist` - from inside a
    // background timer, where nothing was waiting to catch it (AI_LOG 55).
    //
    // No aliases are needed as a result: the columns already have the names
    // the `WebhookEvent` type expects.
    const rows = await this.prisma.$queryRaw<WebhookEvent[]>`
      UPDATE webhook_events
      SET status = 'PROCESSING',
          "claimedAt" = now(),
          attempts = attempts + 1
      WHERE id = (
        SELECT id
        FROM webhook_events
        WHERE (status = 'PENDING' AND "nextAttemptAt" <= now())
           OR (status = 'PROCESSING'
               AND "claimedAt" < now() - make_interval(secs => ${this.leaseSeconds}::double precision))
        ORDER BY "nextAttemptAt" ASC, "receivedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id,
        "companyId",
        "providerEventId",
        "eventType",
        "payloadHash",
        payload,
        status,
        attempts,
        "receivedAt",
        "nextAttemptAt",
        "claimedAt",
        "processedAt",
        "expenseId",
        "lastError"
    `;

    return rows[0] ?? null;
  }
}
