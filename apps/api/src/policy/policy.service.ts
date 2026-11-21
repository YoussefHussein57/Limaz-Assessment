import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { normaliseCategory } from '../expenses/canonical-payload';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdatePolicyDto } from './dto/update-policy.dto';
import { toPolicyView, type PolicyView } from './policy.types';

/**
 * Reading and changing one company's policy.
 *
 * ---------------------------------------------------------------------------
 * WHAT A POLICY CHANGE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not touch a single existing expense. Not its decision, not its rule
 * hits, not its `policySnapshot`, not its status, and not any review.
 *
 * That is assumption A7, and it is what keeps "why was this flagged?"
 * answerable. Each expense stored the policy it was judged against at
 * submission; re-evaluating history on an edit would rewrite decisions a human
 * may already have acted on, and leave an audit trail that disagrees with
 * itself.
 *
 * The consequence is stated plainly in the UI rather than left implicit:
 * changes apply to NEW evaluations.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY: LAST WRITE WINS, AND THAT IS SAID OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * Two managers editing the policy at the same moment is an ordinary UPDATE
 * race: the later commit wins and the earlier one is overwritten with no
 * conflict reported. There is no version column and no optimistic
 * concurrency check.
 *
 * That is a deliberate stopping point, not an oversight. A policy edit is a
 * deliberate, infrequent, human act by a colleague, unlike a review
 * resolution - where two managers racing is the EXPECTED case and ADR-004
 * exists precisely for it. Adding a version column here would be machinery
 * for a race nobody has. It is recorded as R-31 rather than implied to be
 * handled.
 *
 * What IS guaranteed: a submitting expense always reads one internally
 * consistent policy row. `ExpenseSubmissionService` loads the policy inside
 * its transaction and snapshots the same object it evaluated against, so an
 * edit landing mid-submission either happened before that read or after it -
 * never half of it.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async find(companyId: string): Promise<PolicyView> {
    const row = await this.prisma.policy.findUnique({
      where: { companyId },
      include: { company: { select: { currency: true } } },
    });

    if (!row) {
      // Every company gets a policy when it is created (A5), so this is a
      // broken invariant rather than a normal outcome. It answers 404 because
      // from the caller's side the resource genuinely is not there, and the
      // log line is what says it should have been.
      throw new NotFoundException({
        error: 'not_found',
        message: 'This company has no policy.',
      });
    }

    return toPolicyView(row);
  }

  /**
   * Applies a partial update.
   *
   * `updateMany` with the tenant in its WHERE rather than `update` by id:
   * there is no moment at which this reads a row, decides it belongs to the
   * caller, and then writes it. One statement, one evaluation, no
   * time-of-check-to-time-of-use gap - the same shape as F05's conditional
   * update.
   */
  async update(companyId: string, patch: UpdatePolicyDto): Promise<PolicyView> {
    const data: Prisma.PolicyUpdateManyMutationInput = {};

    if (patch.autoApproveLimitMinor !== undefined) {
      data.autoApproveLimitMinor = patch.autoApproveLimitMinor;
    }

    if (patch.frequencyMaxCount !== undefined) {
      data.frequencyMaxCount = patch.frequencyMaxCount;
    }

    if (patch.frequencyWindowMinutes !== undefined) {
      data.frequencyWindowMinutes = patch.frequencyWindowMinutes;
    }

    if (patch.blockedCategories !== undefined) {
      data.blockedCategories = normaliseBlockedCategories(patch.blockedCategories);
    }

    const result = await this.prisma.policy.updateMany({ where: { companyId }, data });

    if (result.count === 0) {
      throw new NotFoundException({
        error: 'not_found',
        message: 'This company has no policy.',
      });
    }

    if (result.count > 1) {
      // Unreachable: `companyId` is UNIQUE on the policy table. If it ever
      // happens, the caller must not be told it succeeded.
      throw new InternalServerErrorException({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    }

    return this.find(companyId);
  }
}

/**
 * The blocked list, through the SAME normaliser the expense pipeline uses.
 *
 * This is the whole reason `normaliseCategory` was extracted in F03 rather
 * than inlined. The blocked-category rule compares a stored expense category
 * against this list, and both sides must have been produced by the same
 * function - otherwise a manager types " gambling " here, the expense arrives
 * as "GAMBLING", and the rule quietly stops firing. Nothing errors; the
 * company simply stops being protected (F07-B07).
 *
 * Deduplicated AFTER normalising, so "Gambling" and "GAMBLING" collapse into
 * one entry rather than being stored twice and rendered as a confusing list
 * (F07-B06). Sorted so the stored order is stable.
 */
export function normaliseBlockedCategories(input: readonly string[]): string[] {
  const normalised = input
    .map((category) => normaliseCategory(category))
    // Normalising can empty a string that was only whitespace. An empty
    // category would match nothing and sit in the list looking like a rule.
    .filter((category) => category.length > 0);

  return [...new Set(normalised)].sort((a, b) => a.localeCompare(b));
}
