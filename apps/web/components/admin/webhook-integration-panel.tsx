'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Copy, KeyRound, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import {
  fetchWebhookIntegration,
  provisionWebhookIntegration,
  webhookKeys,
} from '@/lib/webhook-queries';
import type { ProvisionedWebhookIntegration } from '@/lib/webhook-types';

/**
 * One company's card webhook integration (F12).
 *
 * ---------------------------------------------------------------------------
 * THE SECRET IS SHOWN ONCE, AND THAT IS A POLICY, NOT A LIMITATION
 * ---------------------------------------------------------------------------
 *
 * Unlike an API key, this one COULD be shown again: it is encrypted rather
 * than hashed, so the server can still decrypt it. It is deliberately not
 * exposed anyway.
 *
 * An endpoint that returned signing secrets on demand would turn one
 * compromised administrator session into every company's signing key - and
 * the whole reason the encryption key lives outside the database is to
 * require two things to go wrong rather than one. Putting the plaintext back
 * on a screen would hand that second thing away.
 *
 * If it is lost, the recovery path is to replace it and reconfigure the
 * provider. There is no lookup, by design.
 */
export function WebhookIntegrationPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [provisioned, setProvisioned] = useState<ProvisionedWebhookIntegration | null>(null);
  const [confirming, setConfirming] = useState(false);

  const query = useQuery({
    queryKey: webhookKeys.integration(companyId),
    queryFn: ({ signal }) => fetchWebhookIntegration(companyId, signal),
  });

  const mutation = useMutation({
    mutationFn: () => provisionWebhookIntegration(companyId),
    onSuccess: async (result) => {
      setConfirming(false);
      setProvisioned(result);
      await queryClient.invalidateQueries({ queryKey: webhookKeys.integration(companyId) });
    },
    retry: false,
  });

  const state = query.data;
  const configured = state?.configured === true;

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Card webhook</h2>
          <p className="mt-1 text-sm text-text-secondary">
            How this company&rsquo;s card provider delivers settled transactions.
          </p>
        </div>

        {configured ? (
          <Button
            variant="secondary"
            className="sm:ml-auto"
            disabled={mutation.isPending}
            onClick={() => setConfirming(true)}
          >
            Replace signing secret
          </Button>
        ) : null}
      </div>

      {mutation.isError ? (
        <div className="px-5 pt-4">
          <Alert tone="danger" title="That did not work">
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : userMessage(mutation.error)}
          </Alert>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="px-5 py-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load the integration"
          description={userMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : !configured ? (
        <EmptyState
          Icon={Webhook}
          title="No integration yet"
          description="Provisioning creates a delivery id and an HMAC signing secret. The secret is shown once — configure the provider with it straight away."
          action={
            <Button pending={mutation.isPending} pendingLabel="Provisioning" onClick={() => mutation.mutate()}>
              Provision integration
            </Button>
          }
        />
      ) : (
        <dl className="text-sm">
          <Row label="Endpoint">
            <code className="font-mono text-xs break-all">/v1/webhooks/card-transactions</code>
          </Row>
          <Row label="Delivery id">
            {/*
              Shown in full, and that is safe: it selects which secret to
              verify against and proves nothing on its own. An attacker who
              knows it is still checked against a secret they do not have.
            */}
            <code className="font-mono text-xs break-all">{state.deliveryId}</code>
          </Row>
          <Row label="Secret version">
            <span className="tabular">{state.secretVersion}</span>
          </Row>
          <Row label="Configured">{formatDateTime(state.createdAt)}</Row>
          {state.rotatedAt ? (
            <Row label="Secret replaced">{formatDateTime(state.rotatedAt)}</Row>
          ) : null}
        </dl>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
        Each delivery is signed HMAC-SHA256 over{' '}
        <code className="font-mono">timestamp + &quot;.&quot; + raw body</code>, with the signing
        secret. The secret itself is never shown again after provisioning.
      </p>

      {confirming ? (
        <ConfirmReplace
          busy={mutation.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => mutation.mutate()}
        />
      ) : null}

      {provisioned ? (
        <SigningSecretReveal
          provisioned={provisioned}
          onClose={() => setProvisioned(null)}
        />
      ) : null}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-text">{children}</dd>
    </div>
  );
}

function ConfirmReplace({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/40" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5">
          <Dialog.Title className="text-sm font-semibold text-text">
            Replace the signing secret?
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-1 text-sm text-pretty text-text-secondary">
              <p>
                The current secret stops working <strong className="text-text">immediately</strong>
                . There is no grace window, unlike API key rotation: a webhook secret lives in one
                place, and the provider retries until it succeeds, so a delivery signed with the
                old one is delayed rather than lost.
              </p>
              <p className="mt-2">
                The delivery id does not change, so only the secret has to be updated at the
                provider.
              </p>
            </div>
          </Dialog.Description>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="danger" pending={busy} pendingLabel="Replacing" onClick={onConfirm}>
              Replace it
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The one and only place a signing secret is displayed.
 *
 * Held in one piece of state in the parent, cleared on close. Not in a query
 * cache, not in storage, not in the URL, not logged - the same handling the
 * API key reveal gets, for the same reasons.
 */
function SigningSecretReveal({
  provisioned,
  onClose,
}: {
  provisioned: ProvisionedWebhookIntegration;
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
      await navigator.clipboard.writeText(provisioned.signingSecret);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/50" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-5">
          <div className="flex gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-success-bg text-success">
              <KeyRound className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-text">
                Webhook integration ready
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-pretty text-text-secondary">
                Configure the card provider with both values below.
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="delivery-id" className="text-xs font-medium text-text-secondary">
              Delivery id — sent as x-limaz-webhook-id
            </label>
            <input
              id="delivery-id"
              readOnly
              value={provisioned.integration.deliveryId}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              className="mt-1 h-11 w-full rounded-control border border-border-input bg-surface-subtle px-3 font-mono text-xs text-text"
            />
          </div>

          <div className="mt-3">
            <label htmlFor="signing-secret" className="text-xs font-medium text-text-secondary">
              Signing secret — the HMAC-SHA256 key
            </label>
            <input
              id="signing-secret"
              readOnly
              value={provisioned.signingSecret}
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
              This is the only time the signing secret is shown. It is not retrievable here
              afterwards — if you lose it, replace it and reconfigure the provider.
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
                  Copy secret
                </>
              )}
            </Button>
            <Button onClick={onClose}>I have stored it</Button>
          </div>

          <p className="mt-4 border-t border-border pt-3 text-xs text-text-secondary">
            Anyone holding this secret can submit expenses as this company. The sandbox simulator
            signs on the server and never receives it.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
