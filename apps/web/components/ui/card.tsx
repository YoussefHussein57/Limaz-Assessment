import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A surface that groups related content.
 *
 * Uses the DECORATIVE border token. A card edge is not a control boundary, so
 * WCAG 1.4.11's 3:1 requirement does not apply to it - which is exactly why
 * there are two border tokens rather than one.
 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-card border border-border bg-surface', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="border-b border-border px-5 py-4">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {description ? <p className="mt-1 text-sm text-text-secondary">{description}</p> : null}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}
