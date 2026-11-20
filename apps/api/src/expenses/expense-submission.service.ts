import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Company, Expense, Policy, Prisma, RuleHit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normaliseExpense, payloadHashOf, type NormalisedExpense } from './canonical-payload';
import type { SubmitExpenseDto } from './dto/submit-expense.dto';
import { isExpenseIdempotencyConflict } from './idempotency-conflict';
import {
  POLICY_EVALUATOR,
  type PolicyEvaluationResult,
  type PolicyEvaluator,
} from './policy-evaluator.port';

/** A4: how far on either side of now a `spentAt` may legitimately sit. */
const MAX_PAST_DAYS = 90;
const MAX_FUTURE_MINUTES = 5;

export interface SubmissionResult {
  readonly expense: Expense;
  readonly ruleHits: readonly RuleHit[];
  /** True when this request matched an expense that already existed. */
  readonly duplicate: boolean;
}

/**
 * Submits one expense, exactly once.
 *
 * The ordering below is the feature. Each position is defended in place,
 * because the natural order - validate everything, then check for duplicates -
 * is subtly wrong in two different ways.
 */
@Injectable()
export class ExpenseSubmissionService {
  private readonly logger = new Logger(ExpenseSubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(POLICY_EVALUATOR) private readonly evaluator: PolicyEvaluator,
  ) {}

  async submit(companyId: string, dto: SubmitExpenseDto): Promise<SubmissionResult> {
    const normalised = normaliseExpense({
      employeeId: dto.employeeId,
      amountMinor: dto.amount,
      currency: dto.currency,
      merchant: dto.merchant,
      category: dto.category,
      spentAt: new Date(dto.spentAt),
    });

    const payloadHash = payloadHashOf(normalised);

    try {
      return await this.runSubmission(companyId, dto.externalId, normalised, payloadHash);
    } catch (error) {
      // The INSERT lost a race. The transaction is already rolled back, so the
      // winner is read on a fresh connection - see resolveLostRace().
      if (isExpenseIdempotencyConflict(error)) {
        return this.resolveLostRace(companyId, dto.externalId, payloadHash);
      }

      throw error;
    }
  }

  private async runSubmission(
    companyId: string,
    externalId: string,
    normalised: NormalisedExpense,
    payloadHash: string,
  ): Promise<SubmissionResult> {
    return this.prisma.$transaction(async (tx) => {
      // ---------------------------------------------------------------------
      // 1. The advisory lock, FIRST (ADR-007).
      //
      // It is transaction-scoped, so it is released by COMMIT or ROLLBACK -
      // including a rollback caused by the process dying. The session variant
      // would leak the lock onto a pooled connection and poison it for every
      // later request.
      //
      // Idempotency does NOT need this lock; the unique constraint is what
      // guarantees that. It is taken here because F04's frequency count is a
      // read-then-write, which the constraint cannot protect, and because the
      // lock has to be the first statement for the count that follows to see
      // every competitor that has already committed. Building the transaction
      // in this order once is safer than reordering it later underneath tests
      // that already passed.
      //
      // Parameterised, never interpolated: both arguments are caller-supplied.
      // ---------------------------------------------------------------------
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId}), hashtext(${normalised.employeeId}))`;

      // ---------------------------------------------------------------------
      // 2. Idempotency, BEFORE the time-dependent validation.
      //
      // An expense accepted ninety-one days ago is still a legitimate thing to
      // retry. Checking the A4 window first would reject that retry with a 422
      // for a rule the original submission satisfied, and the caller would
      // have no way to ever stop retrying (test F03-T25).
      //
      // Shape validation already ran, and is time-independent by design, so
      // the request reaching here is known to be well-formed.
      // ---------------------------------------------------------------------
      const existing = await tx.expense.findUnique({
        where: { companyId_externalId: { companyId, externalId } },
        include: { ruleHits: true },
      });

      if (existing) {
        return this.resolveExisting(existing, payloadHash);
      }

      // ---------------------------------------------------------------------
      // 3. Business validation: tenant- and time-dependent (422, not 400).
      // ---------------------------------------------------------------------
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });

      this.assertCurrencyMatches(company, normalised.currency);
      this.assertWithinSubmissionWindow(normalised.spentAt);

      // ---------------------------------------------------------------------
      // 4. Policy, then evaluation - inside the lock, so a frequency count can
      //    be correct. In F03 no production evaluator is bound at all.
      // ---------------------------------------------------------------------
      const policy = await tx.policy.findUnique({ where: { companyId } });

      if (!policy) {
        // A company without a policy is a seeding or provisioning failure, not
        // a caller error. Refusing is the only safe answer: there is no
        // defensible decision to assign without one.
        this.logger.error(`Company ${companyId} has no policy row; cannot evaluate.`);
        throw new InternalServerErrorException({
          error: 'policy_missing',
          message: 'This company has no spending policy configured.',
        });
      }

      const evaluation = await this.evaluator.evaluate({
        expense: normalised,
        policy,
        companyId,
        tx,
      });

      // ---------------------------------------------------------------------
      // 5. Persist. The UNIQUE constraint is the final authority: if a
      //    competitor committed between step 2 and here, this INSERT raises
      //    23505 and the whole transaction rolls back.
      // ---------------------------------------------------------------------
      const expense = await tx.expense.create({
        data: {
          companyId,
          externalId,
          employeeId: normalised.employeeId,
          amountMinor: normalised.amountMinor,
          currency: normalised.currency,
          merchant: normalised.merchant,
          category: normalised.category,
          spentAt: normalised.spentAt,
          decision: evaluation.decision,
          status: statusFor(evaluation.decision),
          payloadHash,
          policySnapshot: snapshotOf(policy),
        },
      });

      const ruleHits: RuleHit[] = [];

      for (const hit of evaluation.ruleHits) {
        ruleHits.push(
          await tx.ruleHit.create({
            data: {
              expenseId: expense.id,
              ruleCode: hit.ruleCode,
              decision: hit.decision,
              detail: hit.detail as Prisma.InputJsonValue,
            },
          }),
        );
      }

      // A8: a review exists only for a REVIEW decision.
      if (evaluation.decision === 'REVIEW') {
        await tx.review.create({ data: { expenseId: expense.id, companyId } });
      }

      return { expense, ruleHits, duplicate: false };
    });
  }

  /**
   * Resolves the outcome after losing the INSERT race.
   *
   * WHY THIS CANNOT HAPPEN INSIDE THE TRANSACTION
   *
   * A unique violation puts the PostgreSQL transaction into an ABORTED state.
   * Every subsequent statement, including a plain SELECT, fails with
   * `25P02 current transaction is aborted, commands ignored until end of
   * transaction block`. Catching the error and reading the winning row in the
   * same transaction does not work - it produces a second, more confusing
   * error, and is how this path usually ends up as a 500.
   *
   * The alternative is a SAVEPOINT before the INSERT and a ROLLBACK TO on
   * conflict. It works, and it costs raw savepoint SQL inside a Prisma
   * interactive transaction for a path that is rare by construction. The
   * transaction is allowed to roll back completely instead, and the winner is
   * read afterwards on a fresh connection, on a unique index.
   *
   * The winner cannot have disappeared in between: expenses are never deleted
   * by this service, and `Company.onDelete: Restrict` prevents a company from
   * being removed while it still has any. If it is somehow missing, that is a
   * 500 and not a quiet success.
   */
  private async resolveLostRace(
    companyId: string,
    externalId: string,
    payloadHash: string,
  ): Promise<SubmissionResult> {
    const winner = await this.prisma.expense.findUnique({
      where: { companyId_externalId: { companyId, externalId } },
      include: { ruleHits: true },
    });

    if (!winner) {
      this.logger.error(
        `Unique violation on ${companyId}/${externalId}, but no row was found afterwards.`,
      );
      throw new InternalServerErrorException({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    }

    return this.resolveExisting(winner, payloadHash);
  }

  /**
   * The same decision for a row found before the insert and a row found after
   * losing the race, so the two paths cannot drift apart.
   */
  private resolveExisting(
    existing: Expense & { ruleHits: RuleHit[] },
    payloadHash: string,
  ): SubmissionResult {
    if (existing.payloadHash === payloadHash) {
      // A genuine retry. The ORIGINAL decision is returned unchanged: no
      // re-evaluation, no second rule hit, no second review, and nothing added
      // to a future frequency window.
      return { expense: existing, ruleHits: existing.ruleHits, duplicate: true };
    }

    // Same identity, different facts. Not a retry - a client bug, a reused
    // identifier, or an attempt to overwrite a decision already issued. The
    // service cannot tell which, and all three deserve a refusal (ADR-001).
    throw new ConflictException({
      error: 'conflict',
      message: `externalId '${existing.externalId}' already exists for this company with a different payload.`,
      details: {
        conflictingField: 'externalId',
        externalId: existing.externalId,
        existing: {
          id: existing.id,
          decision: existing.decision,
          status: existing.status,
          spentAt: existing.spentAt.toISOString(),
        },
      },
    });
  }

  /**
   * A3: one currency per company, no conversion.
   *
   * 422 rather than 400: the request is well formed, and whether `USD` is
   * acceptable depends on which company is asking. A 400 would tell the caller
   * their JSON was malformed, which it was not.
   */
  private assertCurrencyMatches(company: Company, currency: string): void {
    if (company.currency !== currency) {
      throw new UnprocessableEntityException({
        error: 'currency_mismatch',
        message: `This company records expenses in ${company.currency}; received ${currency}.`,
      });
    }
  }

  /**
   * A4: no more than 90 days old, no more than 5 minutes ahead.
   *
   * The future bound exists for clock skew between the caller's servers and
   * ours; beyond it, a timestamp is either wrong or an attempt to place an
   * expense in a frequency window that has not happened yet.
   */
  private assertWithinSubmissionWindow(spentAt: Date): void {
    const now = Date.now();
    const ageMs = now - spentAt.getTime();

    if (ageMs > MAX_PAST_DAYS * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        error: 'spent_at_too_old',
        message: `spentAt must be within ${MAX_PAST_DAYS} days of now.`,
      });
    }

    if (ageMs < -MAX_FUTURE_MINUTES * 60 * 1000) {
      throw new UnprocessableEntityException({
        error: 'spent_at_in_future',
        message: `spentAt must not be more than ${MAX_FUTURE_MINUTES} minutes in the future.`,
      });
    }
  }
}

/**
 * The status implied by a decision.
 *
 * Mirrors `expenses_decision_status_check`. The constraint is the authority -
 * this exists so a violation is impossible rather than merely caught, and if
 * the two ever disagree the database wins and the INSERT fails loudly.
 */
function statusFor(decision: PolicyEvaluationResult['decision']) {
  switch (decision) {
    case 'APPROVE':
      return 'APPROVED' as const;
    case 'REJECT':
      return 'REJECTED' as const;
    case 'REVIEW':
      return 'PENDING_REVIEW' as const;
  }
}

/**
 * A7: the policy settings this expense was judged against.
 *
 * Only the fields that affect a decision. Timestamps and ids are excluded -
 * they make the snapshot differ between two expenses judged under identical
 * settings, which would make "were these judged the same way?" unanswerable by
 * comparison.
 */
function snapshotOf(policy: Policy): Prisma.InputJsonValue {
  return {
    autoApproveLimitMinor: policy.autoApproveLimitMinor,
    frequencyMaxCount: policy.frequencyMaxCount,
    frequencyWindowMinutes: policy.frequencyWindowMinutes,
    blockedCategories: policy.blockedCategories,
  };
}

/** Exported for the DTO's 400 path, which is raised by the controller. */
export function invalidRequest(message: string): BadRequestException {
  return new BadRequestException({ error: 'invalid_request', message });
}
