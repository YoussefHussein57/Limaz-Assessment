import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { ExpenseListItem } from '@/lib/expense-types';
import { DecisionBadge, StatusBadge } from './status-badges';

/**
 * One page of expenses, rendered as a table on a wide screen and as cards on a
 * narrow one.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPONENT, TWO PRESENTATIONS - NOT TWO COMPONENTS
 * ---------------------------------------------------------------------------
 *
 * Both renderings read the SAME `items` and call the SAME formatters. Nothing
 * is computed in one branch and not the other, so the two cannot drift: a
 * change to how an amount is displayed changes both, and there is no second
 * place for a currency bug to hide.
 *
 * The alternative considered was keeping the table at every width and letting
 * it scroll horizontally. Rejected: at 360px a nine-column table puts Status -
 * the column a manager is actually looking for - behind a horizontal scroll
 * with no indication it exists. "No essential information silently hidden" is
 * a requirement, and a scrollbar the user never discovers hides it.
 *
 * The breakpoint is `md` (768px), which is where a table stops being readable
 * rather than where it stops fitting.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE ROW IS NOT A LINK
 * ---------------------------------------------------------------------------
 *
 * A `<tr>` cannot contain an `<a>` that wraps its cells, and nesting one per
 * cell would announce nine identical links to a screen reader. So there is ONE
 * link per row, on the merchant - the thing a person would point at - with a
 * `::after` overlay making the entire row clickable for a mouse. One
 * accessible name, one tab stop, the whole row as a target.
 */
export function ExpenseRows({ items }: { items: readonly ExpenseListItem[] }) {
  return (
    <>
      {/* ---------------- table, md and up ---------------- */}
      <div className="hidden md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Expenses, newest first by the date the money was spent. Each row links to the full
            expense.
          </caption>
          <thead>
            <tr className="bg-surface-subtle text-left">
              <Th>Merchant</Th>
              <Th>Reference</Th>
              <Th>Employee</Th>
              <Th className="hidden lg:table-cell">Category</Th>
              <Th className="text-right">Amount</Th>
              <Th className="hidden lg:table-cell">Spent</Th>
              <Th>Decision</Th>
              <Th>Status</Th>
              <Th className="w-8">
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {items.map((expense) => (
              <tr
                key={expense.id}
                className="relative border-t border-border transition-colors duration-150 hover:bg-surface-subtle focus-within:bg-surface-subtle"
              >
                <Td>
                  <Link
                    href={`/dashboard/expenses/${expense.id}`}
                    className="font-medium text-text after:absolute after:inset-0 after:content-['']"
                  >
                    {expense.merchant}
                  </Link>
                </Td>
                <Td className="font-mono text-xs text-text-secondary">{expense.externalId}</Td>
                <Td className="font-mono text-xs text-text-secondary">{expense.employeeId}</Td>
                <Td className="hidden text-text-secondary lg:table-cell">{expense.category}</Td>
                <Td className="tabular text-right font-medium whitespace-nowrap">
                  {formatMoney(expense.amountMinor, expense.currency)}
                </Td>
                <Td className="hidden whitespace-nowrap text-text-secondary lg:table-cell">
                  {formatDateTime(expense.spentAt)}
                </Td>
                <Td>
                  <DecisionBadge decision={expense.decision} />
                </Td>
                <Td>
                  <StatusBadge status={expense.status} />
                </Td>
                <Td className="text-right">
                  <ChevronRight className="size-4 text-text-secondary" aria-hidden="true" />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------- cards, below md ---------------- */}
      <ul className="divide-y divide-border md:hidden">
        {items.map((expense) => (
          <li key={expense.id} className="relative">
            <Link
              href={`/dashboard/expenses/${expense.id}`}
              // 44px of vertical padding plus content: a comfortable thumb
              // target without making the list feel sparse.
              className="flex flex-col gap-2 px-4 py-4 transition-colors duration-150 hover:bg-surface-subtle"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-medium text-text">{expense.merchant}</span>
                <span className="tabular shrink-0 font-medium whitespace-nowrap">
                  {formatMoney(expense.amountMinor, expense.currency)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-text-secondary">
                <span>{expense.externalId}</span>
                <span aria-hidden="true">·</span>
                <span>{expense.employeeId}</span>
                <span aria-hidden="true">·</span>
                <span className="font-sans">{expense.category}</span>
              </div>

              <div className="text-xs text-text-secondary">{formatDateTime(expense.spentAt)}</div>

              {/* The same two badges as the table. Nothing is dropped on a
                  phone: a smaller screen gets a different layout, not less
                  information. */}
              <div className="flex flex-wrap gap-1.5">
                <DecisionBadge decision={expense.decision} />
                <StatusBadge status={expense.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 text-xs font-medium tracking-wide text-text-secondary uppercase ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}
