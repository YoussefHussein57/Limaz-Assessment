'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Building2, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { ADMIN_PAGE_SIZE, adminKeys, createCompany, fetchCompanies } from '@/lib/admin-queries';
import type { CreateCompanyResult } from '@/lib/admin-types';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDate, parseMajorUnits, pluralise } from '@/lib/format';
import { SecretReveal } from './secret-reveal';

/**
 * The platform administrator's workspace: every company, and a way to add one.
 *
 * This IS the administrator overview. A separate summary page was considered
 * and rejected - it would have needed either its own aggregate endpoint or
 * numbers derived from one page of companies, and the only figures worth
 * showing (how many companies, how many cannot authenticate) are visible on
 * the rows themselves.
 *
 * Same listing machinery as the manager side: keyset pagination, a cursor
 * trail for "Newer", debounced search, the URL as the single source of filter
 * state. Two listings behaving differently for no reason is how one
 * application starts feeling like two.
 */
export function CompanyWorkspace() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  const search = searchParams.get('q') ?? '';
  const cursor = searchParams.get('cursor');

  const [trail, setTrail] = useState<(string | null)[]>([]);
  const lastSearch = useRef(search);

  useEffect(() => {
    if (lastSearch.current !== search) {
      lastSearch.current = search;
      setTrail([]);
    }
  }, [search]);

  const write = useCallback(
    (nextSearch: string, nextCursor: string | null) => {
      const params = new URLSearchParams();

      if (nextSearch) params.set('q', nextSearch);
      if (nextCursor) params.set('cursor', nextCursor);

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const query = useQuery({
    queryKey: adminKeys.companyList(search, cursor),
    queryFn: ({ signal }) => fetchCompanies(search, cursor, signal),
    placeholderData: keepPreviousData,
  });

  const [created, setCreated] = useState<CreateCompanyResult | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const companies = query.data?.items ?? [];
  const expired = query.error instanceof ApiError && query.error.status === 401;

  useEffect(() => {
    if (expired) {
      window.location.assign('/login?reason=expired');
    }
  }, [expired]);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <SearchInput
            label="Search"
            placeholder="Company name"
            value={search}
            onChange={(value) => {
              setTrail([]);
              write(value, null);
            }}
          />
        </div>

        <Button onClick={() => setFormOpen(true)} className="sm:ml-auto">
          <Plus className="size-4" aria-hidden="true" />
          Add a company
        </Button>
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div
          aria-hidden="true"
          className={`h-0.5 transition-opacity duration-150 ${
            query.isFetching && !query.isLoading
              ? 'animate-pulse bg-accent opacity-100'
              : 'opacity-0'
          }`}
        />

        <div aria-live="polite" className="sr-only">
          {query.isLoading
            ? 'Loading companies'
            : query.isError
              ? 'Could not load companies'
              : `${pluralise(companies.length, 'company', 'companies')} shown`}
        </div>

        {query.isLoading ? (
          <LoadingRows />
        ) : query.isError && !expired ? (
          <EmptyState
            Icon={AlertCircle}
            tone="danger"
            title="Could not load companies"
            description={userMessage(query.error)}
            action={
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : companies.length === 0 ? (
          search ? (
            <EmptyState
              Icon={Building2}
              title="No company matches that name"
              description="Try a different search, or clear it to see every company."
              action={
                <Button variant="secondary" onClick={() => write('', null)}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              Icon={Building2}
              title="No companies yet"
              description="Add one to create its policy and issue its first API key."
              action={<Button onClick={() => setFormOpen(true)}>Add a company</Button>}
            />
          )
        ) : (
          <ul key={cursor ?? 'first'} className="anim-enter divide-y divide-border">
            {companies.map((company) => (
              <li key={company.id}>
                <Link
                  href={`/admin/companies/${company.id}`}
                  className="flex flex-col gap-2 px-4 py-4 transition-colors duration-150 hover:bg-surface-subtle sm:flex-row sm:items-center sm:px-5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{company.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
                      <span>{company.currency}</span>
                      <span aria-hidden="true">·</span>
                      <span>Added {formatDate(company.createdAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{company.id.slice(0, 8)}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2 sm:ml-auto">
                    {/*
                      "No working key" is the only status worth a badge here,
                      and it is a REAL one derived from the same predicate
                      authentication uses - not an invented "active company"
                      flag. A company that cannot authenticate cannot submit
                      anything, and that is the one thing an administrator
                      should see from the list.
                    */}
                    {company.activeApiKeys === 0 ? (
                      <Badge tone="danger">No working key</Badge>
                    ) : (
                      <Badge tone="neutral">
                        {pluralise(company.activeApiKeys, 'active key')}
                      </Badge>
                    )}
                    <ChevronRight
                      className="hidden size-4 text-text-secondary sm:block"
                      aria-hidden="true"
                    />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {companies.length > 0 ? (
          <nav
            aria-label="Company pages"
            className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center"
          >
            <p className="text-sm text-text-secondary">
              {pluralise(companies.length, 'company', 'companies')} on page {trail.length + 1}
            </p>

            <div className="flex gap-2 sm:ml-auto">
              <Button
                variant="secondary"
                size="sm"
                disabled={cursor === null || query.isFetching}
                onClick={() =>
                  setTrail((previous) => {
                    const next = [...previous];
                    write(search, next.pop() ?? null);

                    return next;
                  })
                }
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                {trail.length > 0 ? 'Newer' : 'First page'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!query.data?.nextCursor || query.isFetching}
                onClick={() => {
                  const next = query.data?.nextCursor;

                  if (next) {
                    setTrail((previous) => [...previous, cursor]);
                    write(search, next);
                  }
                }}
              >
                Older
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </div>

      {formOpen ? (
        <CreateCompanyDialog
          onClose={() => setFormOpen(false)}
          onCreated={async (result) => {
            setFormOpen(false);
            setCreated(result);
            await queryClient.invalidateQueries({ queryKey: adminKeys.companies() });
          }}
        />
      ) : null}

      {created ? (
        <SecretReveal
          issued={created.apiKey}
          title={`${created.company.name} created`}
          description="Its policy is set up and this is its first API key. Give it to the company so its backend can submit expenses."
          onClose={() => {
            const id = created.company.id;
            // Clear the secret FIRST, then navigate. The other order would
            // leave the value in state during the transition.
            setCreated(null);
            router.push(`/admin/companies/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Creating a company.
 *
 * A dialog rather than a page: five fields, four of which have sensible
 * defaults. A dedicated route for that would be navigation with nothing to
 * navigate to.
 *
 * The policy fields are here because a company without a policy cannot decide
 * anything - the API creates one either way, and letting the administrator
 * set it at creation means a company with known rules is correct in one step
 * instead of needing a manager to fix it afterwards.
 */
function CreateCompanyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreateCompanyResult) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [limit, setLimit] = useState('500.00');

  const parsedLimit = parseMajorUnits(limit, currency || 'SAR');
  const currencyValid = /^[A-Za-z]{3}$/u.test(currency.trim());
  const nameValid = name.trim().length > 0;
  const valid = nameValid && currencyValid && parsedLimit.ok;

  const mutation = useMutation({
    mutationFn: () =>
      createCompany({
        name: name.trim(),
        currency: currency.trim().toUpperCase(),
        autoApproveLimitMinor: parsedLimit.ok ? parsedLimit.amountMinor : 0,
      }),
    onSuccess: (result) => void onCreated(result),
    // NOT idempotent: a retry creates a SECOND company and a second API key.
    retry: false,
  });

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/40" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5">
          <Dialog.Title className="text-sm font-semibold text-text">Add a company</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            This creates the company, its expense policy and its first API key together.
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
              <Alert tone="danger" title="Could not create the company">
                {mutation.error instanceof ApiError
                  ? mutation.error.message
                  : userMessage(mutation.error)}
              </Alert>
            ) : null}

            <Field id="company-name" label="Company name">
              <input
                id="company-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                autoFocus
                className="h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="company-currency"
                label="Currency"
                error={currency && !currencyValid ? 'Three letters, for example SAR.' : null}
                hint="One currency per company. Expenses in any other are rejected."
              >
                <input
                  id="company-currency"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  className="h-11 w-full rounded-control border border-border-input bg-surface px-3 font-mono text-sm text-text uppercase transition-colors duration-150 hover:border-text-secondary"
                />
              </Field>

              <Field
                id="company-limit"
                label="Auto-approval limit"
                error={parsedLimit.ok ? null : parsedLimit.reason}
                hint="Expenses above this go to a manager."
              >
                <input
                  id="company-limit"
                  inputMode="decimal"
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  className="tabular h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
                />
              </Field>
            </div>

            <p className="text-xs text-pretty text-text-secondary">
              The frequency rule starts at 3 expenses per 60 minutes and nothing is blocked. The
              company&rsquo;s own manager can change all of that afterwards.{' '}
              <strong className="text-text">No manager account is created</strong> — that is a
              separate step this version does not automate.
            </p>

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
                Create company
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: Math.min(ADMIN_PAGE_SIZE, 5) }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-2 h-3 w-60 max-w-full" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}
