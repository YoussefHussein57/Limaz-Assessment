import type { ReactNode } from 'react';

/**
 * The heading block every page opens with.
 *
 * It renders the only `h1` on the page. Shared so the level, size and spacing
 * cannot drift between the manager and admin areas - which is most of what
 * makes two sections of an application feel like one product.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-text sm:text-2xl">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>

      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}
