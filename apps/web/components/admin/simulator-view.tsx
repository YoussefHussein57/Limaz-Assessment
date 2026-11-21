'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  CreditCard,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { adminKeys, fetchCompanies, fetchCompany } from '@/lib/admin-queries';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatMoney, parseMajorUnits, toMajorUnitString } from '@/lib/format';
import {
  fetchSimulatorState,
  fetchWebhookEvent,
  fetchWebhookIntegration,
  isTerminal,
  simulatePayment,
  webhookKeys,
} from '@/lib/webhook-queries';
import type { SimulationMode, SimulationResult } from '@/lib/webhook-types';

/**
 * The sandbox payment simulator (F12).
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS NOT ALLOWED TO DO
 * ===========================================================================
 *
 * It does not compute a decision. Not once, not as a preview, not as an
 * optimistic hint. Every APPROVE, REVIEW or REJECT on this page is read back
 * from the event row the server wrote after the real policy engine ran. A
 * screen that predicted the answer would agree with the server right up until
 * the moment it mattered.
 *
 * It also never holds the signing secret. The server signs, inside its own
 * process. Nothing on this page could produce a valid signature, which is
 * exactly the property that makes the "invalid signature" preset meaningful.
 *
 * ===========================================================================
 * WHY THE PROGRESS LIST IS DERIVED, NOT ANIMATED
 * ===========================================================================
 *
 * Each step below is a fact with a source: the HTTP status the endpoint
 * returned, or the `status` column on the event. None of them advances on a
 * timer. A timed animation would show "processing" for an event that never
 * left PENDING because the worker is down, which is the one failure this
 * panel exists to make visible.
 */
export function SimulatorView() {
  const simulator = useQuery({
    queryKey: webhookKeys.simulator(),
    queryFn: ({ signal }) => fetchSimulatorState(signal),
  });

  if (simulator.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (simulator.isError) {
    return (
      <Card>
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not read the sandbox configuration"
          description={userMessage(simulator.error)}
        />
      </Card>
    );
  }

  if (!simulator.data?.enabled) {
    return (
      <Card>
        <EmptyState
          Icon={ShieldAlert}
          title="The sandbox is not enabled here"
          description="SANDBOX_SIMULATOR_ENABLED is off on this deployment, so no synthetic payment can be delivered. The API refuses it too — this is not a hidden button."
        />
      </Card>
    );
  }

  return <SimulatorForm endpoint={simulator.data.endpoint} />;
}

type Preset =
  | 'NORMAL'
  | 'ABOVE_LIMIT'
  | 'BLOCKED_CATEGORY'
  | 'FREQUENCY_BURST'
  | 'REPLAY'
  | 'CONFLICT'
  | 'INVALID_SIGNATURE'
  | 'EXPIRED_SIGNATURE';

function SimulatorForm({ endpoint }: { endpoint: string }) {
  const queryClient = useQueryClient();

  const [companyId, setCompanyId] = useState('');
  const [cardholderId, setCardholderId] = useState('emp-7');
  const [merchant, setMerchant] = useState('City Taxi');
  const [category, setCategory] = useState('TRANSPORT');
  const [amountText, setAmountText] = useState('125.00');
  const [mode, setMode] = useState<SimulationMode>('VALID');
  const [note, setNote] = useState<string | null>(null);

  /** The last delivery, so Replay and Conflict have something to reuse. */
  const [last, setLast] = useState<{ eventId: string; transactionId: string } | null>(null);
  const [results, setResults] = useState<SimulationResult[]>([]);

  const companyFieldId = useId();
  const employeeFieldId = useId();
  const merchantFieldId = useId();
  const categoryFieldId = useId();
  const amountFieldId = useId();

  const companies = useQuery({
    queryKey: adminKeys.companyList('', null),
    queryFn: ({ signal }) => fetchCompanies('', null, signal),
  });

  const company = useQuery({
    queryKey: adminKeys.company(companyId),
    queryFn: ({ signal }) => fetchCompany(companyId, signal),
    enabled: companyId !== '',
  });

  const integration = useQuery({
    queryKey: webhookKeys.integration(companyId),
    queryFn: ({ signal }) => fetchWebhookIntegration(companyId, signal),
    enabled: companyId !== '',
  });

  const currency = company.data?.currency ?? 'SAR';
  const policy = company.data?.policy ?? null;
  const parsed = parseMajorUnits(amountText, currency);
  const configured = integration.data?.configured === true;

  const mutation = useMutation({
    mutationFn: (overrides: {
      mode?: SimulationMode;
      amountMinor?: number;
      category?: string;
      cardholderId?: string;
      replayOf?: string;
      eventId?: string;
      transactionId?: string;
    }) =>
      simulatePayment({
        companyId,
        mode: overrides.mode ?? mode,
        cardholderId: overrides.cardholderId ?? cardholderId.trim(),
        merchant: merchant.trim(),
        category: (overrides.category ?? category).trim(),
        amount: overrides.amountMinor ?? (parsed.ok ? parsed.amountMinor : 0),
        ...(overrides.replayOf ? { replayOf: overrides.replayOf } : {}),
        ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
        ...(overrides.transactionId ? { transactionId: overrides.transactionId } : {}),
      }),
    onSuccess: async (result) => {
      setResults((previous) => [result, ...previous].slice(0, 8));

      // Only a delivery the endpoint ACCEPTED is worth replaying. Replaying
      // one it refused would just refuse again, for the original reason.
      const transactionId = readTransactionId(result.requestBody);

      if (result.delivery.status < 400 && transactionId) {
        setLast({ eventId: result.providerEventId, transactionId });
      }

      await queryClient.invalidateQueries({ queryKey: webhookKeys.events() });
    },
    // NOT retried: a retry is a second delivery, and whether that is a
    // duplicate depends on an id the client never saw.
    retry: false,
  });

  const runPreset = (preset: Preset) => {
    setNote(null);

    if (!companyId || !policy) {
      return;
    }

    switch (preset) {
      case 'NORMAL': {
        // Comfortably under the limit, so the only thing that could flag it
        // is the frequency rule - which is the honest caveat, not a promise.
        const amountMinor = Math.max(1, Math.floor(policy.autoApproveLimitMinor / 2));
        setAmountText(toMajorUnitString(amountMinor, currency));
        setCategory('TRANSPORT');
        setMode('VALID');
        mutation.mutate({ mode: 'VALID', amountMinor, category: 'TRANSPORT' });
        return;
      }

      case 'ABOVE_LIMIT': {
        const amountMinor = policy.autoApproveLimitMinor + 10_000;
        setAmountText(toMajorUnitString(amountMinor, currency));
        setMode('VALID');
        mutation.mutate({ mode: 'VALID', amountMinor, category: 'TRANSPORT' });
        return;
      }

      case 'BLOCKED_CATEGORY': {
        const blocked = policy.blockedCategories[0];

        if (!blocked) {
          // Changing the policy to make a preset work would be the simulator
          // inventing the rule it claims to demonstrate.
          setNote(
            'This company blocks no categories, so there is nothing to demonstrate. Its own manager sets the blocked list on the policy page — the simulator will not change a policy to make a preset work.',
          );
          return;
        }

        setCategory(blocked);
        setMode('VALID');
        mutation.mutate({ mode: 'VALID', category: blocked });
        return;
      }

      case 'FREQUENCY_BURST': {
        void runBurst(policy.frequencyMaxCount);
        return;
      }

      case 'REPLAY': {
        if (!last) {
          setNote('Deliver a payment first — a replay needs an event to replay.');
          return;
        }

        // The server reads the STORED payload back and re-signs it. Passing
        // the id alone and rebuilding from the form would send a different
        // payment under the same identity, which is a conflict rather than a
        // replay - and is what this preset did at first (AI_LOG 56).
        mutation.mutate({ mode: 'VALID', replayOf: last.eventId });
        return;
      }

      case 'CONFLICT': {
        if (!last) {
          setNote('Deliver a payment first — a conflict needs an event id to reuse.');
          return;
        }

        // The same event id with a DIFFERENT payload. Not a retry: the same
        // identifier now describes a different payment.
        mutation.mutate({
          mode: 'VALID',
          eventId: last.eventId,
          transactionId: `${last.transactionId}-altered`,
          amountMinor: (parsed.ok ? parsed.amountMinor : 10_000) + 1,
        });
        return;
      }

      case 'INVALID_SIGNATURE':
        setMode('INVALID_SIGNATURE');
        mutation.mutate({ mode: 'INVALID_SIGNATURE' });
        return;

      case 'EXPIRED_SIGNATURE':
        setMode('EXPIRED_SIGNATURE');
        mutation.mutate({ mode: 'EXPIRED_SIGNATURE' });
    }
  };

  /**
   * Delivers enough payments for one employee to trip the frequency rule.
   *
   * A FRESH employee id, because the rule counts that employee's existing
   * history too - reusing `emp-7` would make the result depend on whatever
   * was submitted earlier today, and a preset whose outcome varies is not a
   * demonstration.
   *
   * Sequential, awaiting each delivery. Sent together they would race, and
   * the one that happened to arrive fourth would be the one flagged - which
   * is correct behaviour and a confusing thing to watch.
   */
  const runBurst = async (maxCount: number) => {
    const employee = `emp-burst-${Date.now().toString(36)}`;
    const amountMinor = Math.max(1, Math.floor((policy?.autoApproveLimitMinor ?? 20_000) / 4));

    setCardholderId(employee);

    for (let index = 0; index <= maxCount; index += 1) {
      await mutation.mutateAsync({
        mode: 'VALID',
        cardholderId: employee,
        amountMinor,
        category: 'TRANSPORT',
      });
    }
  };

  const ready = companyId !== '' && configured && parsed.ok && cardholderId.trim().length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title="Sandbox — simulated payments only">
          No real money is transferred and no card details are involved. This signs a synthetic
          provider event and posts it to{' '}
          <code className="font-mono text-xs break-all">{endpoint}</code>, the same endpoint a real
          card provider would call.
        </Alert>

        <Card>
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-text">Simulated payment</h2>
            <p className="mt-1 text-sm text-text-secondary">
              The server builds, signs and delivers it. Nothing here can produce a signature.
            </p>
          </div>

          <form
            className="flex flex-col gap-4 px-5 py-4"
            onSubmit={(event) => {
              event.preventDefault();

              if (ready && !mutation.isPending) {
                setNote(null);
                mutation.mutate({});
              }
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={companyFieldId} className="text-sm font-medium text-text">
                Company
              </label>
              <select
                id={companyFieldId}
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
                className="h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text"
              >
                <option value="">Choose a company</option>
                {(companies.data?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.currency})
                  </option>
                ))}
              </select>
            </div>

            {companyId && integration.isSuccess && !configured ? (
              <Alert tone="danger" title="No webhook integration yet">
                This company has no signing secret, so nothing can be signed for it. Provision one
                on its{' '}
                <Link href={`/admin/companies/${companyId}`} className="underline">
                  company page
                </Link>{' '}
                first.
              </Alert>
            ) : null}

            {policy ? (
              <div className="rounded-control bg-surface-subtle px-3 py-2 text-xs text-text-secondary">
                <p className="font-medium text-text">This company&rsquo;s policy</p>
                <p className="mt-1">
                  Auto-approve up to{' '}
                  <span className="tabular">
                    {formatMoney(policy.autoApproveLimitMinor, currency)}
                  </span>
                  , more than {policy.frequencyMaxCount} in {policy.frequencyWindowMinutes} min
                  needs review
                  {policy.blockedCategories.length > 0
                    ? `, blocked: ${policy.blockedCategories.join(', ')}`
                    : ', nothing blocked'}
                  .
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={employeeFieldId}
                label="Cardholder"
                value={cardholderId}
                onChange={setCardholderId}
                hint="Becomes the expense's employeeId."
                mono
              />
              <TextField
                id={merchantFieldId}
                label="Merchant"
                value={merchant}
                onChange={setMerchant}
              />
              <TextField
                id={categoryFieldId}
                label="Category"
                value={category}
                onChange={(value) => setCategory(value.toUpperCase())}
                mono
              />
              <div className="flex flex-col gap-1.5">
                <label htmlFor={amountFieldId} className="text-sm font-medium text-text">
                  Amount ({currency})
                </label>
                <input
                  id={amountFieldId}
                  inputMode="decimal"
                  value={amountText}
                  onChange={(event) => setAmountText(event.target.value)}
                  aria-invalid={parsed.ok ? undefined : true}
                  className="tabular h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text"
                />
                {parsed.ok ? (
                  <p className="text-xs text-text-secondary">
                    Sent as{' '}
                    <span className="tabular font-medium">{parsed.amountMinor}</span> minor units —
                    converted from the decimal string, never through a float.
                  </p>
                ) : (
                  <p role="alert" className="text-sm font-medium text-danger">
                    {parsed.reason}
                  </p>
                )}
              </div>
            </div>

            <Button
              type="submit"
              disabled={!ready}
              pending={mutation.isPending}
              pendingLabel="Delivering"
            >
              <CreditCard className="size-4" aria-hidden="true" />
              Simulate payment
            </Button>
          </form>

          <div className="border-t border-border px-5 py-4">
            <p className="text-xs font-medium text-text">Presets</p>
            <p className="mt-1 text-xs text-text-secondary">
              Each one sends a real signed request. None of them disables a check.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ['NORMAL', 'Normal payment'],
                  ['ABOVE_LIMIT', 'Above amount limit'],
                  ['BLOCKED_CATEGORY', 'Blocked category'],
                  ['FREQUENCY_BURST', 'Frequency burst'],
                  ['REPLAY', 'Replay event'],
                  ['CONFLICT', 'Conflicting event'],
                  ['INVALID_SIGNATURE', 'Invalid signature'],
                  ['EXPIRED_SIGNATURE', 'Expired signature'],
                ] as [Preset, string][]
              ).map(([preset, label]) => (
                <Button
                  key={preset}
                  size="sm"
                  variant="secondary"
                  disabled={!companyId || !configured || mutation.isPending}
                  onClick={() => runPreset(preset)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {note ? (
              <p role="alert" className="mt-3 text-sm text-text-secondary">
                {note}
              </p>
            ) : null}
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        {mutation.isError ? (
          <Alert tone="danger" title="The simulation itself failed">
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : userMessage(mutation.error)}
          </Alert>
        ) : null}

        {results.length === 0 ? (
          <Card>
            <EmptyState
              Icon={CreditCard}
              title="Nothing delivered yet"
              description="Choose a company and send a payment. Every step below is read back from the server — none of it is animated."
            />
          </Card>
        ) : (
          results.map((result, index) => (
            <DeliveryResult key={`${result.providerEventId}-${index}`} result={result} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * One delivery, step by step.
 *
 * The five stages are deliberately separate facts, because they fail
 * independently and a reader needs to know which one did:
 *
 *   1. the HTTP request reached the endpoint
 *   2. the signature verified
 *   3. the event was durably stored
 *   4. a worker processed it
 *   5. the policy decided something
 *
 * A policy REJECT at stage five is a SUCCESSFUL run of stages one to four.
 * Colouring it as a failure would teach the reader the wrong lesson about
 * what their integration is doing.
 */
function DeliveryResult({ result }: { result: SimulationResult }) {
  const accepted = result.delivery.status < 400;

  // Polls only while the event can still change, and stops on its own. There
  // is no interval that keeps running after the page moves on.
  const event = useQuery({
    queryKey: webhookKeys.event(result.eventId ?? ''),
    queryFn: ({ signal }) => fetchWebhookEvent(result.eventId!, signal),
    enabled: result.eventId !== null,
    refetchInterval: (query) =>
      query.state.data && isTerminal(query.state.data.status) ? false : 700,
  });

  const status = event.data?.status ?? null;
  const rejectionReason = readMessage(result.delivery.body);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="font-mono text-xs break-all text-text">{result.providerEventId}</span>
        <span className="ml-auto flex items-center gap-2">
          <Badge tone={accepted ? 'neutral' : 'danger'}>HTTP {result.delivery.status}</Badge>
          {result.mode !== 'VALID' ? <Badge tone="warning">{modeLabel(result.mode)}</Badge> : null}
        </span>
      </div>

      <ol className="flex flex-col gap-0 px-5 py-3">
        <Step state="done" label="Synthetic transaction generated and signed by the server" />
        <Step
          state="done"
          label={`Signed request delivered — the endpoint answered ${result.delivery.status}`}
        />
        <Step
          state={accepted ? 'done' : 'failed'}
          label={
            accepted
              ? 'Signature and timestamp verified'
              : `Refused: ${rejectionReason ?? 'the signature or timestamp was not accepted'}`
          }
          detail={
            accepted
              ? undefined
              : 'The verifier ran normally. Nothing was stored and no expense exists.'
          }
        />
        {accepted ? (
          <>
            <Step
              state="done"
              label={
                readStatus(result.delivery.body) === 'DUPLICATE'
                  ? 'Already received — no second event was created'
                  : readStatus(result.delivery.body) === 'IGNORED'
                    ? 'Stored, and deliberately not processed (unsupported event type)'
                    : 'Durably stored in the event inbox'
              }
            />
            <Step
              state={
                status === null || status === 'PENDING'
                  ? 'waiting'
                  : status === 'PROCESSING'
                    ? 'running'
                    : status === 'FAILED'
                      ? 'failed'
                      : 'done'
              }
              label={
                status === 'PROCESSED'
                  ? `Processed after ${event.data?.attempts ?? 1} attempt${
                      (event.data?.attempts ?? 1) === 1 ? '' : 's'
                    }`
                  : status === 'FAILED'
                    ? `Processing failed: ${event.data?.lastError ?? 'unknown'}`
                    : status === 'IGNORED'
                      ? 'Not processed — this event type is ignored'
                      : status === 'PROCESSING'
                        ? 'A worker is processing it'
                        : 'Waiting for a worker'
              }
            />
            {event.data?.decision ? (
              <Step
                state="done"
                label={`Policy decided ${event.data.decision}`}
                detail={
                  event.data.expenseId ? (
                    <>
                      Expense{' '}
                      <span className="font-mono break-all">{event.data.expenseId}</span>, final
                      status {event.data.expenseStatus}. The company&rsquo;s manager sees it in
                      their dashboard.
                    </>
                  ) : undefined
                }
              />
            ) : null}
          </>
        ) : null}
      </ol>
    </Card>
  );
}

function Step({
  state,
  label,
  detail,
}: {
  state: 'done' | 'failed' | 'waiting' | 'running';
  label: string;
  detail?: React.ReactNode;
}) {
  const Icon =
    state === 'done'
      ? CheckCircle2
      : state === 'failed'
        ? XCircle
        : state === 'running'
          ? Loader2
          : CircleDashed;

  return (
    <li className="flex gap-3 border-b border-border py-2.5 last:border-b-0">
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${
          state === 'done'
            ? 'text-success'
            : state === 'failed'
              ? 'text-danger'
              : state === 'running'
                ? 'animate-spin text-accent'
                : 'text-text-secondary'
        }`}
      />
      <div className="min-w-0">
        <p className="text-sm text-text">{label}</p>
        {detail ? <p className="mt-0.5 text-xs text-text-secondary">{detail}</p> : null}
      </div>
    </li>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text ${
          mono ? 'font-mono' : ''
        }`}
      />
      {hint ? <p className="text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function modeLabel(mode: SimulationMode): string {
  return mode === 'INVALID_SIGNATURE' ? 'Wrong signature' : 'Stale timestamp';
}

function readMessage(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const shaped = body as { message?: unknown };

    return typeof shaped.message === 'string' ? shaped.message : null;
  }

  return null;
}

function readStatus(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const shaped = body as { status?: unknown };

    return typeof shaped.status === 'string' ? shaped.status : null;
  }

  return null;
}

function readTransactionId(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const shaped = body as { data?: { transactionId?: unknown } };

    return typeof shaped.data?.transactionId === 'string' ? shaped.data.transactionId : null;
  }

  return null;
}
