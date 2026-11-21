'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { adminKeys, fetchCompany } from '@/lib/admin-queries';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ApiKeyPanel } from './api-key-panel';
import { ManagerPanel } from './manager-panel';

/**
 * One company, from the administrator side.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ADMINISTRATOR CAN SEE HERE, AND WHAT THEY CANNOT
 * ---------------------------------------------------------------------------
 *
 * They can see the company exists, how it is configured, and manage its
 * credentials. They **cannot** see its expenses, and there is no link to any.
 *
 * Managing a company's account is not the same authority as reading its
 * spending, and the API does not grant the second one: every expense and
 * review route is `@Roles('MANAGER')`, so an administrator is refused there
 * whatever this page renders.
 *
 * The policy is shown **read only**. Editing it belongs to the company's own
 * manager (F07) - an administrator deciding what another company
 * auto-approves is an authority no approved contract grants.
 */
export function CompanyDetailView({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: adminKeys.company(companyId),
    queryFn: ({ signal }) => fetchCompany(companyId, signal),
  });

  if (query.isLoading) {
    return <DetailSkeleton />;
  }

  if (query.isError) {
    const error = query.error;
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);

    return (
      <div className="rounded-card border border-border bg-surface">
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title={missing ? 'That company is not here' : 'Could not load this company'}
          description={missing ? 'It does not exist on this deployment.' : userMessage(error)}
          action={
            missing ? (
              <Link
                href="/admin"
                className="inline-flex h-11 items-center rounded-control border border-border-input bg-surface px-4 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-subtle"
              >
                Back to companies
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            )
          }
        />
      </div>
    );
  }

  const company = query.data!;

  return (
    <>
      <Link
        href="/admin"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to companies
      </Link>

      <header className="mb-6">
        <h1 className="text-xl font-semibold break-words text-text sm:text-2xl">
          {company.name}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
          <span>{company.currency}</span>
          <span aria-hidden="true">·</span>
          <span>Added {formatDateTime(company.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-xs break-all">{company.id}</span>
        </p>
      </header>

      {/*
        The most actionable thing on the page, so it is at the top rather than
        buried. A company with no manager cannot sign in - nobody can review
        its flagged expenses, and they simply accumulate.

        Until F11 this said the same thing and offered no way out, because
        provisioning meant writing a row by hand (R-32). It now names the
        panel that fixes it, three cards down, so the warning ends somewhere.
      */}
      {company.managerCount === 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="Nobody can sign in for this company yet">
            Its backend can submit expenses, but every expense the policy flags will wait
            unreviewed. Add a manager below to finish setting the company up.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="flex flex-col gap-4">
          {/*
            Managers first, API keys second. That is the order a company is
            actually set up in: the key only matters once somebody can look at
            what it submits.
          */}
          <ManagerPanel companyId={company.id} />

          <ApiKeyPanel companyId={company.id} />

          <Card>
            <CardHeader
              title="Integration"
              description="How this company's backend submits an expense."
            />
            <div className="px-5 py-4">
              {/*
                A placeholder, never a live key. Injecting a real secret into
                a copyable example would put it on screen permanently, in a
                place the one-time display exists to prevent.
              */}
              <pre className="overflow-x-auto rounded-control bg-surface-subtle p-3 font-mono text-xs text-text">
                {`POST /v1/expenses
x-api-key: YOUR_API_KEY
content-type: application/json

{
  "externalId": "your-reference",
  "employeeId": "emp-1",
  "amount": 12500,
  "currency": "${company.currency}",
  "merchant": "Supplier",
  "category": "OFFICE",
  "spentAt": "2026-11-21T09:00:00.000Z"
}`}
              </pre>
              <p className="mt-2 text-xs text-text-secondary">
                The amount is in minor units. The key goes in a header, never a query parameter.
              </p>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              title="Expense policy"
              description="Set when the company was created. Its own manager edits it."
            />

            {company.policy ? (
              <dl className="text-sm">
                <Row label="Auto-approval limit">
                  <span className="tabular">
                    {formatMoney(company.policy.autoApproveLimitMinor, company.currency)}
                  </span>
                </Row>
                <Row label="Frequency rule">
                  <span className="tabular">
                    {company.policy.frequencyMaxCount} per {company.policy.frequencyWindowMinutes}{' '}
                    min
                  </span>
                </Row>
                <Row label="Blocked categories">
                  {company.policy.blockedCategories.length > 0
                    ? company.policy.blockedCategories.join(', ')
                    : 'None'}
                </Row>
              </dl>
            ) : (
              <p className="px-5 py-4 text-sm text-danger">
                This company has no policy. It cannot evaluate any expense — that should be
                impossible, because creation makes both together.
              </p>
            )}

            <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
              Read only here. Changing a company&rsquo;s spending rules is its manager&rsquo;s
              authority, not an administrator&rsquo;s.
            </p>
          </Card>

          <Card>
            <CardHeader title="Accounts" />
            <dl className="text-sm">
              <Row label="Managers">{company.managerCount}</Row>
              <Row label="Working API keys">{company.activeApiKeys}</Row>
            </dl>
            <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
              An administrator manages accounts and credentials. This company&rsquo;s expenses are
              not visible here, and the API refuses them to an administrator whatever this page
              shows.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-text">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the company">
      <Skeleton className="h-4 w-36" />
      <div className="mt-4 mb-6">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-card border border-border bg-surface">
          <div className="border-b border-border px-5 py-4">
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
        <div className="rounded-card border border-border bg-surface">
          <div className="border-b border-border px-5 py-4">
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    </div>
  );
}
