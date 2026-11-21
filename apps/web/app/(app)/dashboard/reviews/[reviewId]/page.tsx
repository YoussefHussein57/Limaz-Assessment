import { ReviewDetailView } from '@/components/reviews/review-detail-view';
import { requireUser } from '@/lib/auth';

/**
 * One review.
 *
 * The page itself is a Server Component only so far as the auth gate: it
 * resolves the id and hands it to a client view.
 *
 * That is the opposite of the expense detail, deliberately. This page carries
 * a MUTATION whose purpose is to change what the page shows - and, when
 * another manager gets there first, to show something different from what the
 * server rendered a moment ago. Fetching through the same cache the mutation
 * invalidates keeps one answer to "what does the server say right now";
 * server-rendering it would leave stale HTML above a message contradicting it.
 */
export const dynamic = 'force-dynamic';

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  await requireUser();

  const { reviewId } = await params;

  return <ReviewDetailView reviewId={reviewId} />;
}
