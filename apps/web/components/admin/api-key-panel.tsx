'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, KeyRound, Plus, RefreshCw, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  adminKeys,
  fetchApiKeys,
  issueApiKey,
  revokeApiKey,
  rotateApiKey,
} from '@/lib/admin-queries';
import type { ApiKeyState, ApiKeySummary, IssuedApiKey } from '@/lib/admin-types';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { ConfirmKeyAction, SecretReveal } from './secret-reveal';

/**
 * A company's API keys, and the three operations on them.
 *
 * ---------------------------------------------------------------------------
 * ROTATE AND REVOKE MUST NOT LOOK INTERCHANGEABLE
 * ---------------------------------------------------------------------------
 *
 * They do different things and are reached for in different situations:
 *
 *   **Rotate** - a planned replacement. The old key keeps working for 24
 *                hours so the company can deploy the new one across its
 *                servers without an outage. Secondary styling.
 *   **Revoke** - an emergency. The key stops working immediately, with no
 *                grace, because the reason you revoke is that it leaked.
 *                Danger styling, and its confirmation says "immediately".
 *
 * A UI that renders them as two similar buttons invites somebody reaching for
 * a routine replacement to cut a company off instead.
 */
export function ApiKeyPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  /**
   * The ONLY place a plaintext secret lives.
   *
   * Component state, cleared the moment the dialog closes. Never a query key:
   * a cache survives navigation, is garbage-collected on its own schedule,
   * and is walked by devtools and error reporters.
   */
  const [issued, setIssued] = useState<{ value: IssuedApiKey; kind: 'issued' | 'rotated' } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<{ key: ApiKeySummary; action: 'rotate' | 'revoke' } | null>(
    null,
  );

  const query = useQuery({
    queryKey: adminKeys.apiKeys(companyId),
    queryFn: ({ signal }) => fetchApiKeys(companyId, signal),
    staleTime: 0,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: adminKeys.apiKeys(companyId) }),
      // The company's "active keys" count changes too.
      queryClient.invalidateQueries({ queryKey: adminKeys.companies() }),
    ]);

  const issueMutation = useMutation({
    mutationFn: () => issueApiKey(companyId),
    onSuccess: async (result) => {
      setIssued({ value: result, kind: 'issued' });
      await refresh();
    },
    // NOT idempotent: a retry mints a SECOND credential. An automatic retry
    // on a flaky connection would leave a company with a key nobody knows
    // about and nobody can see the value of.
    retry: false,
  });

  const rotateMutation = useMutation({
    mutationFn: (keyId: string) => rotateApiKey(companyId, keyId),
    onSuccess: async (result) => {
      setConfirming(null);
      setIssued({ value: result, kind: 'rotated' });
      await refresh();
    },
    onError: () => setConfirming(null),
    retry: false,
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokeApiKey(companyId, keyId),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
    onError: () => setConfirming(null),
    retry: false,
  });

  const busy =
    issueMutation.isPending || rotateMutation.isPending || revokeMutation.isPending;

  const error = issueMutation.error ?? rotateMutation.error ?? revokeMutation.error;
  const keys = query.data?.items ?? [];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">API keys</h2>
          <p className="mt-1 text-sm text-text-secondary">
            The credentials this company&rsquo;s backend authenticates with.
          </p>
        </div>

        <Button
          className="sm:ml-auto"
          disabled={busy}
          pending={issueMutation.isPending}
          pendingLabel="Issuing"
          onClick={() => issueMutation.mutate()}
        >
          <Plus className="size-4" aria-hidden="true" />
          Issue a key
        </Button>
      </div>

      {error ? (
        <div className="px-5 pt-4">
          {/* The API message, which names the actual lifecycle state - "this
              key was revoked", "already rotated". Never a raw error. */}
          <Alert tone="danger" title="That did not work">
            {error instanceof ApiError ? error.message : userMessage(error)}
          </Alert>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load the keys"
          description={userMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : keys.length === 0 ? (
        <EmptyState
          Icon={KeyRound}
          title="No API keys"
          description="This company cannot submit expenses until it has one."
        />
      ) : (
        <ul className="divide-y divide-border">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm text-text">{key.prefix}…</code>
                  <KeyStateBadge state={key.state} />
                </div>

                <p className="mt-1 text-xs text-text-secondary">
                  Created {formatDateTime(key.createdAt)}
                  {key.state === 'GRACE' && key.expiresAt
                    ? ` · stops working ${formatDateTime(key.expiresAt)}`
                    : null}
                  {key.state === 'EXPIRED' && key.expiresAt
                    ? ` · expired ${formatDateTime(key.expiresAt)}`
                    : null}
                  {key.revokedAt ? ` · revoked ${formatDateTime(key.revokedAt)}` : null}
                </p>
              </div>

              <div className="flex gap-2 sm:ml-auto">
                {/* Offered only when the backend would accept it. The backend
                    still decides - this is an affordance, not a check. */}
                {key.state === 'ACTIVE' ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming({ key, action: 'rotate' })}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Rotate
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming({ key, action: 'revoke' })}
                    >
                      <ShieldOff className="size-4" aria-hidden="true" />
                      Revoke
                    </Button>
                  </>
                ) : key.state === 'GRACE' ? (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirming({ key, action: 'revoke' })}
                  >
                    <ShieldOff className="size-4" aria-hidden="true" />
                    Revoke now
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-pretty text-text-secondary">
        Keys are stored as a SHA-256 hash, so the full value cannot be retrieved after it is
        issued. <strong className="text-text">Rotate</strong> replaces a key and leaves the old
        one working for 24 hours. <strong className="text-text">Revoke</strong> stops a key
        immediately, with no grace period.
      </p>

      {confirming ? (
        <ConfirmKeyAction
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          busy={busy}
          tone={confirming.action === 'revoke' ? 'danger' : 'primary'}
          title={
            confirming.action === 'rotate'
              ? 'Rotate this API key?'
              : 'Revoke this API key immediately?'
          }
          confirmLabel={confirming.action === 'rotate' ? 'Rotate key' : 'Revoke key'}
          body={
            confirming.action === 'rotate' ? (
              <>
                A new key is issued and shown once. The current key{' '}
                <code className="font-mono text-xs">{confirming.key.prefix}…</code> keeps working
                for <strong className="text-text">24 hours</strong>, so the company can deploy the
                replacement without an outage.
              </>
            ) : (
              <>
                <code className="font-mono text-xs">{confirming.key.prefix}…</code> stops
                authenticating <strong className="text-text">immediately</strong> — there is no
                grace period. Any backend still using it will start failing. Use this when a key
                has leaked; to replace one routinely, rotate it instead.
              </>
            )
          }
          onConfirm={() =>
            confirming.action === 'rotate'
              ? rotateMutation.mutate(confirming.key.id)
              : revokeMutation.mutate(confirming.key.id)
          }
        />
      ) : null}

      {issued ? (
        <SecretReveal
          issued={issued.value}
          title={issued.kind === 'rotated' ? 'Replacement key issued' : 'API key issued'}
          description={
            issued.kind === 'rotated'
              ? 'The previous key keeps working for 24 hours. Give this one to the company before then.'
              : 'Give this to the company so its backend can submit expenses.'
          }
          // THIS is what ends the secret's life in the browser.
          onClose={() => setIssued(null)}
        />
      ) : null}
    </Card>
  );
}

/**
 * The lifecycle label.
 *
 * Four states, derived on the server from the same predicate authentication
 * uses - so a key labelled Active genuinely authenticates and one labelled
 * Expired genuinely does not. A badge computed from `status` alone would call
 * a key with a passed `expiresAt` "rotating" while it had already stopped
 * working.
 */
function KeyStateBadge({ state }: { state: ApiKeyState }) {
  switch (state) {
    case 'ACTIVE':
      return <Badge tone="success">Active</Badge>;
    case 'GRACE':
      return <Badge tone="warning">Grace period</Badge>;
    case 'EXPIRED':
      return <Badge tone="neutral">Expired</Badge>;
    case 'REVOKED':
      return <Badge tone="danger">Revoked</Badge>;
  }
}
