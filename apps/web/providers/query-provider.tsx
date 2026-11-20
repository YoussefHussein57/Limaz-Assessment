'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api-error';

/**
 * Server state for the parts of the UI whose parameters change under the
 * user's fingers.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT IN HERE
 * ---------------------------------------------------------------------------
 *
 * Only the expense LISTING uses this. The overview and the expense detail are
 * Server Components: their parameters come from the URL and do not change
 * while the reader looks at them, so they are rendered on the server with no
 * loading state, no client fetch and nothing cached in the browser at all.
 *
 * That is the dividing line: client fetching where the request changes
 * interactively, server fetching where it does not. Marking the whole
 * application a Client Component to have one caching story would mean paying
 * for a round trip, a spinner and a bundle on pages that need none of it.
 *
 * ---------------------------------------------------------------------------
 * HOW CACHED DATA IS KEPT OUT OF THE NEXT SESSION
 * ---------------------------------------------------------------------------
 *
 * Two mechanisms, deliberately both:
 *
 * 1. The AUTHENTICATED LAYOUT mounts this with `key={user.id}`. A different
 *    user unmounts the provider and a brand-new QueryClient is constructed,
 *    so there is no cache to read from - rather than an old cache somebody
 *    remembered to clear.
 *
 * 2. `useState(() => new QueryClient())` - the factory runs ONCE per mount.
 *    A module-level client would be shared by every render of every session
 *    in the same browser tab, which is the classic way one tenant's data
 *    survives a logout.
 *
 * The same-origin proxy means the session cookie is attached by the browser
 * automatically; nothing here holds a credential, so there is no token to
 * leak between the two.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /**
             * Thirty seconds. Within it, remounting a list (navigating to an
             * expense and back) renders instantly from cache; after it, the
             * next mount refetches in the background while showing what it
             * has.
             *
             * Zero would refetch on every mount, which turns "go back" into a
             * visible reload for data that almost certainly has not changed.
             * Infinity would never notice a newly submitted expense without a
             * hard refresh.
             */
            staleTime: 30_000,

            /** Kept for five minutes after nothing is using it. */
            gcTime: 5 * 60_000,

            /**
             * NOT on window focus. The listing is a table a manager reads
             * while switching to another window to check something; refetching
             * on return can reorder rows under a cursor that is mid-read. The
             * explicit refresh affordance and `staleTime` cover the real need.
             */
            refetchOnWindowFocus: false,

            /**
             * A 4xx will not become a 2xx by asking again. Retrying a 401
             * especially - the session is gone, and three more attempts only
             * delay the redirect to the login page.
             *
             * Network failures and 5xx get two retries with the default
             * exponential backoff.
             */
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.isClientError) {
                return false;
              }

              return failureCount < 2;
            },
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
