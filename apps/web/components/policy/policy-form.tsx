'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDateTime, formatMoney, parseMajorUnits, toMajorUnitString } from '@/lib/format';
import { fetchPolicy, policyKeys, updatePolicy } from '@/lib/review-queries';
import type { CompanyPolicy, PolicyPatch } from '@/lib/review-types';

/**
 * The company's policy, read and edited.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SENT, AND WHY IT IS NOT THE WHOLE FORM
 * ---------------------------------------------------------------------------
 *
 * Save builds a PATCH of ONLY the fields that differ from what was loaded.
 * Sending the whole object every time would overwrite a field another manager
 * changed a second ago with the value this form merely happened to be
 * displaying - turning an edit of one field into a silent revert of another.
 *
 * It also means pressing Save with nothing changed sends NO REQUEST at all.
 * The button is disabled in that state, and the comparison is what decides it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE PROMISES, PRECISELY
 * ---------------------------------------------------------------------------
 *
 * "Changes apply to new expense evaluations. Previously evaluated expenses
 * keep their original policy and decision."
 *
 * That is assumption A7 and it is exactly what the backend does: nothing here
 * re-evaluates history. The wording deliberately does NOT say anything about
 * `spentAt` - an expense submitted tomorrow for money spent last week is
 * evaluated against the policy in force when it ARRIVES, not when it was
 * spent, and claiming otherwise would describe a feature nobody built.
 */
export function PolicyForm() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: policyKeys.current(),
    queryFn: ({ signal }) => fetchPolicy(signal),
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return <FormSkeleton />;
  }

  if (query.isError) {
    return (
      <div className="rounded-card border border-border bg-surface">
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load the policy"
          description={userMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <PolicyEditor
      policy={query.data!}
      // Remounting on every saved version resets the form's local state to
      // the new server truth. Without the key, a field the server normalised
      // differently from what was typed (a category, say) would keep showing
      // the typed version until a reload.
      key={query.data!.updatedAt}
      onSaved={() => queryClient.invalidateQueries({ queryKey: policyKeys.all })}
    />
  );
}

function PolicyEditor({
  policy,
  onSaved,
}: {
  policy: CompanyPolicy;
  onSaved: () => void;
}) {
  const [limitText, setLimitText] = useState(() =>
    toMajorUnitString(policy.autoApproveLimitMinor, policy.currency),
  );
  const [maxCount, setMaxCount] = useState(String(policy.frequencyMaxCount));
  const [windowMinutes, setWindowMinutes] = useState(String(policy.frequencyWindowMinutes));
  const [categories, setCategories] = useState<string[]>(() => [...policy.blockedCategories]);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const parsedLimit = parseMajorUnits(limitText, policy.currency);
  const parsedCount = parsePositiveInt(maxCount, 1, 1_000);
  const parsedWindow = parsePositiveInt(windowMinutes, 1, 1_440);

  const errors = {
    limit: parsedLimit.ok ? null : parsedLimit.reason,
    count: parsedCount.ok ? null : parsedCount.reason,
    window: parsedWindow.ok ? null : parsedWindow.reason,
  };

  const valid = parsedLimit.ok && parsedCount.ok && parsedWindow.ok;

  /**
   * Only what actually differs from the loaded policy.
   *
   * Computed on every render rather than memoised. The inputs are three
   * parsed values and an array comparison - cheaper than the dependency
   * array a `useMemo` would need, and a memo keyed on the parsed OBJECTS
   * would recompute every render anyway since they are built fresh each
   * time. A memo that never hits is a stale-closure risk with no upside.
   */
  const patch: PolicyPatch = {};

  if (parsedLimit.ok && parsedLimit.amountMinor !== policy.autoApproveLimitMinor) {
    patch.autoApproveLimitMinor = parsedLimit.amountMinor;
  }

  if (parsedCount.ok && parsedCount.value !== policy.frequencyMaxCount) {
    patch.frequencyMaxCount = parsedCount.value;
  }

  if (parsedWindow.ok && parsedWindow.value !== policy.frequencyWindowMinutes) {
    patch.frequencyWindowMinutes = parsedWindow.value;
  }

  if (!sameCategories(categories, policy.blockedCategories)) {
    patch.blockedCategories = categories;
  }

  const dirty = Object.keys(patch).length > 0;

  const mutation = useMutation({
    mutationFn: () => updatePolicy(patch),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
    // A 4xx will not pass by being sent again; the manager has to change
    // something first.
    retry: false,
  });

  // The confirmation is temporary. A "Saved" badge that never leaves stops
  // meaning "just now" and starts meaning nothing.
  useEffect(() => {
    if (!saved) return;

    const timer = setTimeout(() => setSaved(false), 4_000);

    return () => clearTimeout(timer);
  }, [saved]);

  const addCategory = () => {
    // Normalised the same way the server will, so the chip the manager sees
    // is the value that will actually be stored - and a duplicate is caught
    // here rather than silently collapsing on save.
    const next = categoryDraft.trim().replace(/\s+/gu, ' ').toUpperCase();

    if (next === '' || categories.includes(next)) {
      setCategoryDraft('');

      return;
    }

    setCategories((current) => [...current, next].sort());
    setCategoryDraft('');
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();

        if (valid && dirty && !mutation.isPending) {
          mutation.mutate();
        }
      }}
      className="flex flex-col gap-4"
    >
      {mutation.isError ? (
        <Alert tone="danger" title="Could not save the policy">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : 'Something went wrong. Nothing was changed.'}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Spending limit"
          description={`An expense above this amount is sent for human review. Amounts are in ${policy.currency}.`}
        />
        <div className="px-5 py-4">
          <Field
            id="policy-limit"
            label={`Auto-approval limit (${policy.currency})`}
            error={errors.limit}
            hint={
              parsedLimit.ok
                ? `Currently ${formatMoney(parsedLimit.amountMinor, policy.currency)}. An expense of exactly this amount is still approved automatically.`
                : undefined
            }
          >
            <input
              id="policy-limit"
              // `inputMode` rather than `type="number"`: a number input lets
              // the browser silently reformat and increments on scroll, and
              // exact money is not a place for either.
              inputMode="decimal"
              value={limitText}
              onChange={(event) => setLimitText(event.target.value)}
              className="tabular h-11 w-full max-w-xs rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Frequency rule"
          description="An employee submitting more than this many expenses inside the window is sent for review. The window is measured on when the money was spent."
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <Field id="policy-count" label="Expenses allowed" error={errors.count}>
            <input
              id="policy-count"
              inputMode="numeric"
              value={maxCount}
              onChange={(event) => setMaxCount(event.target.value)}
              className="tabular h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
            />
          </Field>

          <Field id="policy-window" label="Within (minutes)" error={errors.window}>
            <input
              id="policy-window"
              inputMode="numeric"
              value={windowMinutes}
              onChange={(event) => setWindowMinutes(event.target.value)}
              className="tabular h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-secondary"
            />
          </Field>

          {parsedCount.ok && parsedWindow.ok ? (
            <p className="text-xs text-text-secondary sm:col-span-2">
              The rule fires on expense number{' '}
              <strong className="text-text">{parsedCount.value + 1}</strong> within{' '}
              {parsedWindow.value} minutes — the count includes the expense being judged.
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Blocked categories"
          description="An expense in one of these categories is rejected outright. Matching ignores case and surrounding spaces."
        />
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap gap-2">
            {categories.length === 0 ? (
              <p className="text-sm text-text-secondary">
                Nothing is blocked. Every category is allowed through the amount and frequency
                rules.
              </p>
            ) : (
              categories.map((category) => (
                <span
                  key={category}
                  className="inline-flex items-center gap-1 rounded-full bg-danger-bg py-1 pr-1 pl-3 text-xs font-medium text-danger"
                >
                  {category}
                  <button
                    type="button"
                    aria-label={`Remove ${category}`}
                    onClick={() => setCategories((c) => c.filter((entry) => entry !== category))}
                    className="inline-flex size-6 items-center justify-center rounded-full transition-colors duration-150 hover:bg-danger/15"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </span>
              ))
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="policy-category" className="sr-only">
              Add a blocked category
            </label>
            <input
              id="policy-category"
              value={categoryDraft}
              onChange={(event) => setCategoryDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // Otherwise Enter submits the whole form while the manager
                  // was only adding a chip.
                  event.preventDefault();
                  addCategory();
                }
              }}
              placeholder="GAMBLING"
              maxLength={64}
              className="h-11 w-full rounded-control border border-border-input bg-surface px-3 text-sm text-text transition-colors duration-150 placeholder:text-text-secondary hover:border-text-secondary sm:max-w-xs"
            />
            <Button variant="secondary" onClick={addCategory} disabled={categoryDraft.trim() === ''}>
              <Plus className="size-4" aria-hidden="true" />
              Add
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 text-sm">
          {saved ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success">
              <Check className="size-4" aria-hidden="true" />
              Saved
            </span>
          ) : dirty ? (
            <span className="font-medium text-warning">You have unsaved changes</span>
          ) : (
            <span className="text-text-secondary">
              Last changed {formatDateTime(policy.updatedAt)}
            </span>
          )}
        </div>

        <div className="flex gap-2 sm:ml-auto">
          {dirty ? (
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setLimitText(toMajorUnitString(policy.autoApproveLimitMinor, policy.currency));
                setMaxCount(String(policy.frequencyMaxCount));
                setWindowMinutes(String(policy.frequencyWindowMinutes));
                setCategories([...policy.blockedCategories]);
                setCategoryDraft('');
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Discard changes
            </Button>
          ) : null}

          {/* Disabled when nothing changed: a save that sends an empty patch
              would be refused by the API anyway, and offering it invites the
              reader to wonder whether it did something. */}
          <Button
            type="submit"
            disabled={!valid || !dirty}
            pending={mutation.isPending}
            pendingLabel="Saving"
          >
            Save changes
          </Button>
        </div>
      </div>

      <p className="text-xs text-pretty text-text-secondary">
        Changes apply to <strong className="text-text">new expense evaluations</strong>. Expenses
        already submitted keep the policy and the decision they were judged with, and reviews
        already decided are not reopened.
      </p>
    </form>
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
  error: string | null;
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
        // `role="alert"` so the message is announced when it appears, not
        // only when the field is next focused.
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}

type ParsedInt = { ok: true; value: number } | { ok: false; reason: string };

function parsePositiveInt(text: string, min: number, max: number): ParsedInt {
  const trimmed = text.trim();

  if (!/^\d+$/u.test(trimmed)) {
    return { ok: false, reason: 'Enter a whole number.' };
  }

  const value = Number(trimmed);

  if (value < min) {
    return { ok: false, reason: `Must be at least ${min}.` };
  }

  if (value > max) {
    return { ok: false, reason: `Must be ${max} or less.` };
  }

  return { ok: true, value };
}

function sameCategories(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const left = [...a].sort();
  const right = [...b].sort();

  return left.every((value, index) => value === right[index]);
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the policy" className="flex flex-col gap-4">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="rounded-card border border-border bg-surface">
          <div className="border-b border-border px-5 py-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-72 max-w-full" />
          </div>
          <div className="flex flex-col gap-2 px-5 py-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-11 w-full max-w-xs" />
          </div>
        </div>
      ))}
    </div>
  );
}
