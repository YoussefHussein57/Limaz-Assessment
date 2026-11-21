import { getCurrentUser } from './auth';

/**
 * Is this request from a platform administrator?
 *
 * ---------------------------------------------------------------------------
 * WHY THE LAYOUT GATE IS NOT ENOUGH ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * `(app)/admin/layout.tsx` renders a 403 explanation INSTEAD of its children
 * when a manager arrives. That is the right experience - a manager who follows
 * a link has done nothing wrong and deserves to be told why it will not open.
 *
 * But a layout discarding `children` does not stop the page from rendering.
 * Next renders them in parallel and composes the result, so the page's output
 * still reaches the client inside the RSC payload even though nothing shows
 * it. Caught by F02.1-T07b, which found the admin page's heading in the HTML
 * served to a manager (AI_LOG 44).
 *
 * Nothing sensitive was in that payload - the admin pages fetch their data on
 * the client, and the API refuses a manager with 403 - so what leaked was two
 * static strings. The STRUCTURE is the problem: the first admin page that
 * server-renders a company name would leak it the same way, silently.
 *
 * So every admin page calls this and returns `null` when it is false. The
 * reader still sees the layout's explanation; the page simply contributes
 * nothing to the payload.
 *
 * NONE OF THIS IS THE SECURITY BOUNDARY. The API answers 403 to a manager
 * whatever the browser renders (F08-B02, F08-B02b). This keeps the payload
 * honest; the guards keep the data safe.
 *
 * ---------------------------------------------------------------------------
 * THE MIRROR CASE HAS NO HELPER, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * An ADMINISTRATOR reaching a manager page is the same problem and is solved
 * the same way, but without a function: those pages already hold the user from
 * `requireUser()`, so they check `user.role` directly and return
 * `<RoleDenied audience="manager" />` BEFORE any `serverFetch` runs. A second
 * helper would mean a second session lookup for an answer already in hand.
 *
 * Checking before the fetch is the whole point. Until F09 those pages fetched
 * first, the API answered 403, and the error boundary reported *"The server
 * did not answer"* over a "Try again" that could never succeed - the network
 * blamed for an authorisation decision (AI_LOG 47).
 */
export async function isPlatformAdmin(): Promise<boolean> {
  const user = await getCurrentUser();

  return user?.role === 'PLATFORM_ADMIN';
}
