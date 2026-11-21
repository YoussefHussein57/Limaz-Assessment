'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { IssuedApiKey } from '@/lib/admin-types';

/**
 * The one and only place a plaintext API key is ever displayed.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SECRET LIVES, AND EVERYWHERE IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It arrives as the return value of a mutation and is held in ONE piece of
 * component state, in the parent, for as long as this dialog is open. On
 * close the parent sets that state to null and the value becomes
 * unreachable.
 *
 * Not in a TanStack Query cache - a cache survives navigation, is garbage
 * collected on its own schedule, and is walked by devtools and error
 * reporters. Not in `localStorage` or `sessionStorage`, which persist across
 * reloads and are readable by anything on the origin. Not in the URL, which
 * goes into history and referrers. Not in any global store. Not logged.
 *
 * ---------------------------------------------------------------------------
 * WHAT "SHOWN ONCE" HONESTLY MEANS
 * ---------------------------------------------------------------------------
 *
 * The server stores only a SHA-256 hash, so after this dialog closes the full
 * value cannot be recovered through any application API - not by an
 * administrator, not by support, not by reading the database. That is a real
 * guarantee and it is the reason the warning is worded as strongly as it is.
 *
 * What it does NOT mean: once a person has copied it, this application has no
 * further control over it. Clearing component state cannot reach their
 * clipboard, their terminal scrollback, or a devtools network panel they left
 * open. The copy says what is true - "you will not be able to retrieve it
 * again **here**" - rather than claiming a protection that does not exist.
 *
 * If the value is lost, the recovery path is to **revoke this key and issue
 * another**. There is no lookup, by design.
 */
export function SecretReveal({
  issued,
  title,
  description,
  onClose,
}: {
  issued: IssuedApiKey;
  title: string;
  description: string;
  /** The parent clears its state here. That is what ends the secret's life. */
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 3_000);

    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // The Clipboard API needs a secure context and a permission that can be
      // refused. Saying so beats a button that silently does nothing - the
      // value is selectable on screen, so there is still a way through.
      setCopyFailed(true);
    }
  };

  return (
    <Dialog.Root
      open
      // Escape and the overlay both route here, so there is no way to dismiss
      // this without the parent clearing the secret.
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/50" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5">
          <div className="flex gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-success-bg text-success">
              <KeyRound className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-text">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-pretty text-text-secondary">
                {description}
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="issued-key" className="text-xs font-medium text-text-secondary">
              API key
            </label>
            {/*
              A read-only input rather than a <code> block: it is selectable
              and keyboard-reachable, so somebody whose clipboard permission
              is refused can still select all and copy manually.

              `spellCheck` and the autocomplete attributes are off so no
              browser feature treats a credential as text worth learning.
            */}
            <input
              id="issued-key"
              readOnly
              value={issued.plaintext}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onFocus={(event) => event.currentTarget.select()}
              className="mt-1 h-11 w-full rounded-control border border-border-input bg-surface-subtle px-3 font-mono text-xs text-text"
            />
          </div>

          <div className="mt-3">
            <Alert tone="warning" title="Copy it now">
              This is the only time the full key is shown. It is stored as a hash, so it cannot be
              retrieved again here — if you lose it, revoke this key and issue another.
            </Alert>
          </div>

          {copyFailed ? (
            <p role="alert" className="mt-2 text-xs font-medium text-danger">
              Could not reach the clipboard. Select the value above and copy it manually.
            </p>
          ) : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? (
                <>
                  <Check className="size-4" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-4" aria-hidden="true" />
                  Copy key
                </>
              )}
            </Button>
            <Button onClick={onClose}>I have stored it</Button>
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs text-text-secondary">
            Send it to the company over a channel you trust. It authenticates as that company:
            whoever holds it <strong className="text-text">is</strong> that company.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The confirmation shown before a consequential key action. */
export function ConfirmKeyAction({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  tone,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  tone: 'primary' | 'danger';
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/40" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5">
          <div className="flex gap-3">
            <div
              className={`flex size-9 shrink-0 items-center justify-center rounded-control ${
                tone === 'danger' ? 'bg-danger-bg text-danger' : 'bg-accent-subtle text-accent'
              }`}
            >
              <TriangleAlert className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-text">{title}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 text-sm text-pretty text-text-secondary">{body}</div>
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button variant={tone} onClick={onConfirm} pending={busy}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
