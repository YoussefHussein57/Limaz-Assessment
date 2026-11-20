import { ShieldX } from 'lucide-react';
import Link from 'next/link';
import { requireUser } from '@/lib/auth';

/**
 * The role gate for platform administration.
 *
 * It renders a 403 PAGE rather than redirecting. A manager who follows a link
 * here has done nothing wrong and deserves to be told why it will not open;
 * a silent bounce back to their own dashboard looks like the application is
 * broken.
 *
 * This is presentation. The API refuses the same request with 403 whatever the
 * browser renders - F02-T12 proves it without a browser involved at all.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  if (user.role !== 'PLATFORM_ADMIN') {
    return (
      <div className="mx-auto max-w-md py-10 text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-card bg-danger-bg">
          <ShieldX className="size-6 text-danger" aria-hidden="true" />
        </span>

        <h1 className="mt-4 text-xl font-semibold text-text">Platform administration</h1>
        <p className="mt-2 text-sm text-text-secondary">
          This area is for platform administrators. You are signed in as a company manager, so it
          is not available to you.
        </p>

        <Link
          href="/dashboard"
          className="mt-5 inline-flex h-11 items-center rounded-control bg-accent px-4 text-sm font-medium text-text-inverse transition-colors duration-150 hover:bg-accent-hover"
        >
          Back to your workspace
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
