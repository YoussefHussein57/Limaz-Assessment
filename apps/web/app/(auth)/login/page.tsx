import { Wallet } from 'lucide-react';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { Alert } from '@/components/ui/alert';
import { ApiUnreachableError, getCurrentUser, homePathFor } from '@/lib/auth';

/**
 * Sign in.
 *
 * This page sits in the `(auth)` route group, OUTSIDE the protected `(app)`
 * group. That placement is what prevents an infinite redirect: if it were
 * inside, an expired session would redirect here, this page would run the auth
 * check, fail it, and redirect here again (test F02.1-T09).
 */
export const dynamic = 'force-dynamic';

const REASONS: Record<string, { tone: 'info' | 'warning'; message: string }> = {
  expired: { tone: 'warning', message: 'Your session has expired. Please sign in again.' },
  signedout: { tone: 'info', message: 'You have been signed out.' },
  signin: { tone: 'info', message: 'Please sign in to continue.' },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let apiDown = false;

  try {
    const user = await getCurrentUser();

    // Already signed in: there is nothing to do here.
    if (user) {
      redirect(homePathFor(user.role));
    }
  } catch (error) {
    if (error instanceof ApiUnreachableError) {
      // Distinguished from "not signed in" deliberately. Showing a login form
      // that cannot possibly work, with no explanation, sends someone into a
      // loop of retyping a password that was never the problem.
      apiDown = true;
    } else {
      throw error;
    }
  }

  const reasonParam = (await searchParams).reason;
  const reason = typeof reasonParam === 'string' ? REASONS[reasonParam] : undefined;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="grid size-11 place-items-center rounded-card bg-accent">
            <Wallet className="size-6 text-text-inverse" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-text">Sign in to LIMAZ</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Expense policy management for your company.
            </p>
          </div>
        </div>

        <div className="rounded-card border border-border bg-surface p-5 sm:p-6">
          {apiDown ? (
            <Alert tone="danger" title="Service unavailable">
              The service is not responding. Signing in will not work until it is back. If you are
              running this locally, check <code className="font-mono">docker compose ps</code>.
            </Alert>
          ) : (
            <>
              {reason ? (
                <div className="mb-4">
                  <Alert tone={reason.tone}>{reason.message}</Alert>
                </div>
              ) : null}

              <LoginForm />
            </>
          )}
        </div>

        {/*
          Seeded credentials are deliberately NOT shown here.
          They are in the README for a reviewer running this locally; printing
          them on the sign-in screen of something that looks like a product is
          the kind of detail that ends up in a screenshot.
        */}
      </div>
    </main>
  );
}
