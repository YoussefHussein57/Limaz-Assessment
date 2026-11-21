import { apiGet, apiSend, queryString } from './api-client';
import type {
  CompanyPolicy,
  PolicyPatch,
  ReviewDecision,
  ReviewDetail,
  ReviewPage,
} from './review-types';

/**
 * Query keys, fetchers and the two mutations F07 adds.
 *
 * ---------------------------------------------------------------------------
 * THE INVALIDATION CONTRACT
 * ---------------------------------------------------------------------------
 *
 * Resolving a review changes FIVE things a reader may be looking at:
 *
 *   1. the review itself        - OPEN becomes RESOLVED
 *   2. every review listing     - it leaves the OPEN queue
 *   3. the expense's detail     - PENDING_REVIEW becomes APPROVED or REJECTED
 *   4. every expense listing    - the status badge changes
 *   5. the dashboard summary    - the pending count drops, another rises
 *
 * Every key is PREFIXED so one call covers a whole family -
 * `reviewKeys.lists()` matches every state filter and every page at once.
 * That is why the filters are the last element of a key rather than baked
 * into the first.
 *
 * Items 3, 4 and 5 live on Server Components, which TanStack Query does not
 * own. `router.refresh()` is what reconciles those, and it is called in the
 * same place for the same reason.
 */

export interface ReviewFilters {
  state: 'OPEN' | 'RESOLVED' | 'ALL';
}

export const DEFAULT_REVIEW_FILTERS: ReviewFilters = { state: 'OPEN' };

export const reviewKeys = {
  all: ['reviews'] as const,
  lists: () => [...reviewKeys.all, 'list'] as const,
  list: (filters: ReviewFilters, cursor: string | null) =>
    [...reviewKeys.lists(), filters, cursor] as const,
  details: () => [...reviewKeys.all, 'detail'] as const,
  detail: (id: string) => [...reviewKeys.details(), id] as const,
};

export const policyKeys = {
  all: ['policy'] as const,
  current: () => [...policyKeys.all, 'current'] as const,
};

/** The review page size. Bounded by the API at 100. */
export const REVIEW_PAGE_SIZE = 25;

export async function fetchReviewPage(
  filters: ReviewFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ReviewPage> {
  const search = queryString({
    state: filters.state,
    cursor: cursor ?? undefined,
    limit: REVIEW_PAGE_SIZE,
  });

  return apiGet<ReviewPage>(`/v1/reviews${search}`, signal);
}

export async function fetchReview(reviewId: string, signal?: AbortSignal): Promise<ReviewDetail> {
  return apiGet<ReviewDetail>(`/v1/reviews/${encodeURIComponent(reviewId)}`, signal);
}

/**
 * Approve or reject.
 *
 * ---------------------------------------------------------------------------
 * PESSIMISTIC, NOT OPTIMISTIC - AND THIS IS THE DECISION OF THE FEATURE
 * ---------------------------------------------------------------------------
 *
 * An optimistic update paints the new state immediately and rolls back if the
 * server disagrees. It is the right default for a toggle, a reorder, a "like"
 * - cheap actions where the server almost always agrees and a brief wrong
 * pixel costs nothing.
 *
 * It is the WRONG default here, for a reason specific to this system: two
 * managers resolving the same review is not a rare failure, it is the case
 * ADR-004 and F05's conditional UPDATE exist for, and the loser gets a 409.
 * An optimistic UI would show that manager "Approved", let them move on, and
 * then take it back - and for the seconds in between, the screen would state
 * as fact a decision that never happened. For money, that is not a cosmetic
 * flicker; it is the interface lying about an audit record.
 *
 * So the button shows a pending state and the result is shown only after the
 * server has committed it. The cost is a visible wait of one round trip on an
 * action a human takes a few times an hour.
 */
export async function resolveReview(
  reviewId: string,
  decision: ReviewDecision,
): Promise<ReviewDetail> {
  return apiSend<ReviewDetail>(
    'POST',
    `/v1/reviews/${encodeURIComponent(reviewId)}/resolve`,
    { decision },
  );
}

export async function fetchPolicy(signal?: AbortSignal): Promise<CompanyPolicy> {
  return apiGet<CompanyPolicy>('/v1/policy', signal);
}

/**
 * Save the policy.
 *
 * A PATCH carrying ONLY the fields that changed. Sending the whole object on
 * every save would overwrite a field another manager edited a second earlier
 * with a value this form merely happened to be displaying - last-write-wins
 * at the level of the whole policy rather than of the field actually touched
 * (R-31).
 */
export async function updatePolicy(patch: PolicyPatch): Promise<CompanyPolicy> {
  return apiSend<CompanyPolicy>('PATCH', '/v1/policy', patch);
}
