'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ComponentProps } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { homePathFor, type UserRole } from '@/lib/auth-shared';

/**
 * The submit event type, derived from the form element rather than named.
 *
 * React 19's types deprecate `FormEvent` with the note that it "doesn't
 * actually exist". Deriving from the JSX prop gives whatever React currently
 * uses and cannot go stale when that changes again.
 */
type FormSubmitEvent = Parameters<NonNullable<ComponentProps<'form'>['onSubmit']>>[0];

interface FieldErrors {
  email?: string;
  password?: string;
}

/**
 * The only form in F02.1, and the only place credentials are handled.
 *
 * It posts through the same-origin proxy, so the Set-Cookie the API returns is
 * first-party on the web origin - which is what makes `SameSite=Lax` protect
 * anything at all (ADR-008).
 *
 * No state library, no form library. Three pieces of state and one submit
 * handler do not justify React Hook Form, and a dependency nobody can explain
 * is a liability under this assessment's rules.
 */
export function LoginForm() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Guards against a second submit.
   *
   * A ref, not the `pending` state: state updates are asynchronous, so two
   * clicks in the same tick both read `pending === false` and both fire. The
   * disabled button covers the mouse; this covers the race (test F02.1-T05).
   */
  const inFlight = useRef(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (!email.trim()) {
      errors.email = 'Enter your email address.';
    } else if (!email.includes('@')) {
      // Deliberately loose. The server is the authority on whether an account
      // exists, and a strict client-side pattern only rejects valid unusual
      // addresses.
      errors.email = 'Enter a valid email address.';
    }

    if (!password) {
      errors.password = 'Enter your password.';
    }

    return errors;
  }

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();

    if (inFlight.current) {
      return;
    }

    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);

    if (Object.keys(errors).length > 0) {
      return;
    }

    inFlight.current = true;
    setPending(true);

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Required on every state-changing browser request. Login included:
          // without it a hostile page could sign a victim into the attacker's
          // account (F02-T16b).
          'x-limaz-client': '1',
        },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (response.status === 401) {
        // One message for both causes, matching the API. Saying which half was
        // wrong would turn this form into an account-enumeration tool.
        setFormError('Email or password is incorrect.');
        return;
      }

      // The proxy answers 502 when it cannot reach the API at all, and a
      // gateway may answer 503 or 504 for the same condition. None of those
      // mean the credentials were wrong, so they must not read like it: the
      // page itself cannot detect a dead API for a visitor with no cookie
      // (`getCurrentUser` skips the round trip when there is nothing to
      // verify), which makes this the only place that visitor finds out.
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        setFormError(
          'Could not reach the server. It may be starting up or down - try again shortly.',
        );
        return;
      }

      if (!response.ok) {
        setFormError('Something went wrong signing you in. Please try again.');
        return;
      }

      const body = (await response.json()) as { user: { role: UserRole } | null };
      const role = body.user?.role ?? 'MANAGER';

      router.replace(homePathFor(role));
      // Clears Next's Router Cache so the next render cannot reuse a shell
      // built for whoever was signed in before (test F02.1-T18).
      router.refresh();
      return;
    } catch {
      // A thrown fetch means the network or the API is unreachable - not that
      // the credentials were wrong. Saying "incorrect password" here would
      // send someone chasing a problem they do not have (test F02.1-T15).
      setFormError('Could not reach the server. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}

      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        inputMode="email"
        autoFocus
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          // Clearing on edit: leaving a stale error beside a field the person
          // is actively fixing reads as the app arguing with them.
          if (fieldErrors.email) {
            setFieldErrors((previous) => ({ ...previous, email: undefined }));
          }
        }}
        error={fieldErrors.email ?? null}
      />

      <Field
        label="Password"
        type={showPassword ? 'text' : 'password'}
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          if (fieldErrors.password) {
            setFieldErrors((previous) => ({ ...previous, password: undefined }));
          }
        }}
        error={fieldErrors.password ?? null}
        trailing={
          <button
            type="button"
            onClick={() => setShowPassword((previous) => !previous)}
            // The label states the ACTION, and aria-pressed states the current
            // state. An icon alone announces nothing.
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            className="inline-flex size-9 items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:text-text"
          >
            {showPassword ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
          </button>
        }
      />

      <Button type="submit" pending={pending} pendingLabel="Signing in" className="mt-1 w-full">
        {pending ? 'Signing in' : 'Sign in'}
      </Button>
    </form>
  );
}
