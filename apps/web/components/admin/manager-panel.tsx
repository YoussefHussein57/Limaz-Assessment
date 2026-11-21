'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Eye, EyeOff, Plus, UserPlus, UserRound } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { adminKeys, createManager, fetchManagers } from '@/lib/admin-queries';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDate, pluralise } from '@/lib/format';

/** Mirrors `createManagerSchema` on the server. Both numbers are explained there. */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;

/**
 * A company's manager accounts (F11).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PANEL EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Before it, creating a company produced a tenant whose backend could submit
 * expenses and whose flagged expenses nobody could ever review - the company
 * had no manager, and provisioning one meant writing a row by hand. That was
 * recorded as R-32 and the detail page said so in a warning that offered no
 * way out.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD, AND WHY IT IS TYPED HERE RATHER THAN GENERATED
 * ---------------------------------------------------------------------------
 *
 * Two shapes were available. The server could mint a password and return it
 * once, exactly as it does for an API key - which would need the whole
 * one-time-secret apparatus, and would mean a lost response leaves an account
 * nobody can sign in to. Or the administrator chooses it and hands it over
 * themselves, which is what happens here.
 *
 * The second is chosen because it is the honest one for a system with no
 * email delivery: SOMEBODY has to carry the first password out of band
 * whichever way it is generated, and this way the response carries no
 * credential at all. There is no `no-store` header on the create response
 * because there is nothing in it worth protecting.
 *
 * What this is NOT: a forced password change on first sign-in, and a password
 * reset flow. Neither exists, and the copy says so rather than implying a
 * protection that is not there.
 */
export function ManagerPanel({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);

  const query = useQuery({
    queryKey: adminKeys.managers(companyId),
    queryFn: ({ signal }) => fetchManagers(companyId, signal),
  });

  const managers = query.data?.items ?? [];

  return (
    <Card>
      {/* Same header shape as the API key panel beside it, for the same
          reason: two panels on one page that lay out differently for no
          reason is how a product starts looking assembled rather than
          designed. */}
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Managers</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Who can sign in for this company and resolve its reviews.
          </p>
        </div>

        <Button className="sm:ml-auto" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden="true" />
          Add manager
        </Button>
      </div>

      <div aria-live="polite" className="sr-only">
        {query.isLoading
          ? 'Loading managers'
          : query.isError
            ? 'Could not load managers'
            : `${pluralise(managers.length, 'manager')}`}
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load managers"
          description={userMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : managers.length === 0 ? (
        <EmptyState
          Icon={UserPlus}
          title="No manager account yet"
          description="This company's backend can submit expenses, but nobody can sign in to review the ones its policy flags. Add a manager to finish setting it up."
          action={<Button onClick={() => setOpen(true)}>Add the first manager</Button>}
        />
      ) : (
        <ul className="divide-y divide-border">
          {managers.map((manager) => (
            <li key={manager.id} className="flex items-start gap-3 px-5 py-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent"
              >
                <UserRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words text-text">{manager.displayName}</p>
                {/*
                  break-all, not truncate: an administrator checking which
                  address they provisioned needs to read all of it, and a long
                  local part must wrap rather than push the row off a 360px
                  screen (the F09 lesson, AI_LOG 48).
                */}
                <p className="font-mono text-xs break-all text-text-secondary">{manager.email}</p>
              </div>
              <p className="shrink-0 text-right text-xs text-text-secondary">
                <span className="block font-medium text-text">Manager</span>
                <span className="block">Added {formatDate(manager.createdAt)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
        A manager sees only this company. Accounts cannot be removed here, so a review resolved by
        somebody who has left still names them.
      </p>

      {open ? (
        <AddManagerDialog companyId={companyId} onClose={() => setOpen(false)} />
      ) : null}
    </Card>
  );
}

function AddManagerDialog({
  companyId,
  onClose,
}: {
  companyId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const passwordHintId = `${passwordId}-hint`;

  const trimmedName = displayName.trim();
  const trimmedEmail = email.trim();

  // Deliberately loose: the SERVER is the authority on whether an address is
  // valid, and a stricter regex here would refuse addresses the server
  // accepts. This only decides whether the button is live.
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmedEmail);

  // Bytes, not characters - bcrypt counts bytes, and so does the server.
  const passwordBytes = new TextEncoder().encode(password).length;
  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const passwordTooLong = passwordBytes > MAX_PASSWORD_BYTES;
  const passwordValid =
    password.length >= MIN_PASSWORD_LENGTH && passwordBytes <= MAX_PASSWORD_BYTES;

  const valid = trimmedName.length > 0 && emailValid && passwordValid;

  const mutation = useMutation({
    mutationFn: () =>
      createManager(companyId, {
        displayName: trimmedName,
        email: trimmedEmail,
        password,
      }),
    onSuccess: async (manager) => {
      // Clear the password the moment it is no longer needed, so it is not
      // sitting in React state behind a success screen.
      setPassword('');
      setRevealed(false);
      setDone(manager.email);

      await queryClient.invalidateQueries({ queryKey: adminKeys.managers(companyId) });
      // The detail header shows `managerCount`, which has just changed.
      await queryClient.invalidateQueries({ queryKey: adminKeys.company(companyId) });
    },
    // NOT idempotent. A retry on an ambiguous failure would either create a
    // second account or hit the unique constraint - and the administrator
    // reconciles against the list rather than guessing.
    retry: false,
  });

  const close = () => {
    setPassword('');
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(next) => !next && !mutation.isPending && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/40" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-5">
          {done ? (
            <>
              <Dialog.Title className="text-sm font-semibold text-text">
                Manager account created
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">
                <span className="font-mono break-all">{done}</span> can sign in now with the
                password you chose.
              </Dialog.Description>

              <div className="mt-4">
                <Alert tone="warning" title="Hand the password over yourself">
                  This deployment sends no email, so there is no invitation and no reset link. Give
                  the password to the person over a channel you trust. They cannot change it in the
                  application — that is not built.
                </Alert>
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDone(null);
                    setDisplayName('');
                    setEmail('');
                    mutation.reset();
                  }}
                >
                  Add another
                </Button>
                <Button onClick={close}>Done</Button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Title className="text-sm font-semibold text-text">
                Add a manager
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-secondary">
                They will be able to sign in, see this company&rsquo;s expenses, resolve its
                reviews and edit its policy. Nothing else.
              </Dialog.Description>

              <form
                className="mt-4 flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();

                  if (valid && !mutation.isPending) {
                    mutation.mutate();
                  }
                }}
              >
                {mutation.isError ? (
                  <Alert
                    tone="danger"
                    title={
                      mutation.error instanceof ApiError && mutation.error.status === 409
                        ? 'That email is already in use'
                        : 'Could not create the manager'
                    }
                  >
                    {mutation.error instanceof ApiError
                      ? mutation.error.message
                      : userMessage(mutation.error)}
                  </Alert>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={nameId} className="text-sm font-medium text-text">
                    Full name
                  </label>
                  <input
                    id={nameId}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={200}
                    autoFocus
                    autoComplete="off"
                    className="h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={emailId} className="text-sm font-medium text-text">
                    Email
                  </label>
                  <input
                    id={emailId}
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    maxLength={320}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-11 w-full rounded-control border border-border-input bg-surface px-3 font-mono text-sm text-text transition-colors duration-150 hover:border-text-secondary"
                  />
                  <p className="text-xs text-text-secondary">
                    This is their sign-in name. It must be unique across the whole deployment, not
                    just this company.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={passwordId} className="text-sm font-medium text-text">
                    Initial password
                  </label>
                  <div className="relative">
                    <input
                      id={passwordId}
                      // A real password input: browsers, password managers and
                      // screen readers all treat it differently from text, and
                      // it keeps the value out of anything that records
                      // keystrokes as content.
                      type={revealed ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      aria-describedby={passwordHintId}
                      aria-invalid={passwordTooShort || passwordTooLong ? true : undefined}
                      className="h-11 w-full rounded-control border border-border-input bg-surface px-3 pr-11 font-mono text-sm text-text transition-colors duration-150 hover:border-text-secondary"
                    />
                    <button
                      type="button"
                      onClick={() => setRevealed((previous) => !previous)}
                      // The label changes with the state, so a screen reader
                      // hears what the button will DO, not what it shows.
                      aria-label={revealed ? 'Hide the password' : 'Show the password'}
                      aria-pressed={revealed}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:text-text"
                    >
                      {revealed ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  <p id={passwordHintId} className="text-xs text-text-secondary">
                    At least {MIN_PASSWORD_LENGTH} characters. You choose it and hand it over
                    yourself — nothing is emailed.
                  </p>
                  {passwordTooShort ? (
                    <p role="alert" className="text-sm font-medium text-danger">
                      At least {MIN_PASSWORD_LENGTH} characters.
                    </p>
                  ) : null}
                  {passwordTooLong ? (
                    <p role="alert" className="text-sm font-medium text-danger">
                      Too long: {passwordBytes} bytes. bcrypt only hashes the first{' '}
                      {MAX_PASSWORD_BYTES}, so the rest would be silently ignored.
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Dialog.Close asChild>
                    <Button variant="secondary" disabled={mutation.isPending}>
                      Cancel
                    </Button>
                  </Dialog.Close>
                  <Button
                    type="submit"
                    disabled={!valid}
                    pending={mutation.isPending}
                    pendingLabel="Creating"
                  >
                    Create manager
                  </Button>
                </div>
              </form>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
