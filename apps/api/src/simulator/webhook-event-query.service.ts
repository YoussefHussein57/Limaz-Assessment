import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor } from '../common/keyset';
import { PrismaService } from '../prisma/prisma.service';
import type { ListWebhookEventsDto } from './dto/simulator.dto';

/**
 * What an administrator may see about one delivery.
 *
 * Built field by field. The event row carries no secret, but it does carry
 * the provider's payload, and publishing it wholesale would mean any field a
 * provider adds later is published too without anybody deciding to.
 */
export interface WebhookEventSummary {
  readonly id: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly attempts: number;
  readonly receivedAt: string;
  readonly nextAttemptAt: string | null;
  readonly processedAt: string | null;
  readonly expenseId: string | null;
  /** The automated decision, once an expense exists. */
  readonly decision: string | null;
  readonly expenseStatus: string | null;
  /** Sanitised at the point it was written. Never a stack trace. */
  readonly lastError: string | null;
}

export interface WebhookEventPage {
  readonly items: readonly WebhookEventSummary[];
  readonly nextCursor: string | null;
}

/**
 * Reading the webhook inbox, for the administrator workspace (F12).
 *
 * Read-only by construction: there is no method here that writes. An
 * administrator cannot retry, cancel or edit an event, and that is
 * deliberate - every one of those would be a way to alter what the policy
 * engine already decided, from a screen whose job is to explain what
 * happened.
 *
 * Keyset over `(receivedAt DESC, id DESC)`, the same shape as every other
 * listing in this codebase. The inbox only ever grows, so offset pagination
 * would repeat rows under a reader exactly as it would on the expense list.
 */
@Injectable()
export class WebhookEventQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListWebhookEventsDto): Promise<WebhookEventPage> {
    const where: Prisma.WebhookEventWhereInput = {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? keysetBefore(query.cursor) : {}),
    };

    const rows = await this.prisma.webhookEvent.findMany({
      where,
      include: { company: { select: { name: true } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    // One query for the whole page's expenses rather than one per row, so
    // this stays two statements however long the page is.
    const expenses = await this.decisionsFor(page.map((row) => row.expenseId));

    return {
      items: page.map((row) => toSummary(row, expenses.get(row.expenseId ?? ''))),
      nextCursor:
        hasMore && last ? encodeCursor({ timestamp: last.receivedAt, id: last.id }) : null,
    };
  }

  /** One event, for the simulator's result panel to poll. */
  async findOne(eventId: string): Promise<WebhookEventSummary> {
    const row = await this.prisma.webhookEvent.findUnique({
      where: { id: eventId },
      include: { company: { select: { name: true } } },
    });

    if (!row) {
      throw new NotFoundException({ error: 'not_found', message: 'No such webhook event.' });
    }

    const expenses = await this.decisionsFor([row.expenseId]);

    return toSummary(row, expenses.get(row.expenseId ?? ''));
  }

  private async decisionsFor(
    expenseIds: readonly (string | null)[],
  ): Promise<Map<string, { decision: string; status: string }>> {
    const ids = expenseIds.filter((id): id is string => id !== null);

    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.expense.findMany({
      where: { id: { in: ids } },
      select: { id: true, decision: true, status: true },
    });

    return new Map(rows.map((row) => [row.id, { decision: row.decision, status: row.status }]));
  }
}

type EventRow = {
  id: string;
  companyId: string;
  company: { name: string };
  providerEventId: string;
  eventType: string;
  status: string;
  attempts: number;
  receivedAt: Date;
  nextAttemptAt: Date;
  processedAt: Date | null;
  expenseId: string | null;
  lastError: string | null;
};

function toSummary(
  row: EventRow,
  expense: { decision: string; status: string } | undefined,
): WebhookEventSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.company.name,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    receivedAt: row.receivedAt.toISOString(),
    // Meaningless once the event is terminal, so it is not shown then.
    nextAttemptAt:
      row.status === 'PENDING' || row.status === 'PROCESSING'
        ? row.nextAttemptAt.toISOString()
        : null,
    processedAt: row.processedAt?.toISOString() ?? null,
    expenseId: row.expenseId,
    decision: expense?.decision ?? null,
    expenseStatus: expense?.status ?? null,
    lastError: row.lastError,
  };
}

/** `(receivedAt, id) < (cursorReceivedAt, cursorId)`, expanded for Prisma. */
function keysetBefore(cursor: string): Prisma.WebhookEventWhereInput {
  const { timestamp: receivedAt, id } = decodeCursor(cursor);

  return {
    OR: [{ receivedAt: { lt: receivedAt } }, { receivedAt, id: { lt: id } }],
  };
}
