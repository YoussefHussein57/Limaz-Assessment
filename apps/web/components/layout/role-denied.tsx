import { ShieldX } from 'lucide-react';
import Link from 'next/link';

/**
 * One screen for "you are signed in, but this area is not yours".
 *
 * It renders a 403 PAGE rather than redirecting. Somebody who follows a link
 * or a bookmark here has done nothing wrong and deserves to be told why it
 * will not open; a silent bounce elsewhere looks like the application is
 * broken.
 *
 * Both directions exist because both can happen:
 *
 *   - a manager reaching `/admin`
 *   - an administrator reaching `/dashboard`, who has `companyId: null` and
 *     so has no company workspace at all
 *
 * The second one used to produce *"The server did not answer"* from the error
 * boundary, because the page fetched first and the API refused with 403. The
 * network was blamed for an authorisation decision (AI_LOG 47).
 *
 * This is presentation. The API refuses the same request whatever the browser
 * renders - F02-T12 and F08-B02 prove it without a browser involved at all.
 */
export function RoleDenied({ audience }: { audience: 'admin' | 'manager' }) {
  const admin = audience === 'admin';

  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-card bg-danger-bg">
        <ShieldX className="size-6 text-danger" aria-hidden="true" />
      </span>

      <h1 className="mt-4 text-xl font-semibold text-text">
        {admin ? 'Platform administration' : 'Company workspace'}
      </h1>

      <p className="mt-2 text-sm text-text-secondary">
        {admin
          ? 'This area is for platform administrators. You are signed in as a company manager, so it is not available to you.'
          : 'This area is for a company’s own manager. You are signed in as a platform administrator, who belongs to no single company, so there is no workspace here to show.'}
      </p>

      <Link
        href={admin ? '/dashboard' : '/admin'}
        className="mt-5 inline-flex h-11 items-center rounded-control bg-accent px-4 text-sm font-medium text-text-inverse transition-colors duration-150 hover:bg-accent-hover"
      >
        {admin ? 'Back to your workspace' : 'Back to platform administration'}
      </Link>
    </div>
  );
}
