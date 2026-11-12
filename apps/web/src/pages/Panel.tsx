import { LABEL } from '../theme/label';
import { useId, type ReactNode } from 'react';

/**
 * The publisher pages' one container: a framed surface with a header bar (title, optional
 * description, optional actions on the right) and a body. `flush` drops the body padding for a
 * grid or list that runs edge to edge (pair it with `<SpigotGrid bare>`).
 */
export function Panel({
  title,
  description,
  actions,
  flush = false,
  className = '',
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 overflow-hidden rounded-lg border border-line bg-surface ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <h2 id={id} className={`${LABEL} text-ink`}>
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

/** Joins KPI tiles into one ruled strip instead of a row of separate boxes. */
export const KPI_STRIP =
  'grid gap-px overflow-hidden rounded-lg border border-line bg-line [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none [&>div]:px-5 [&>div]:py-4';

/** Page frame shared by the publisher pages: width, gutters, vertical rhythm. */
export const PAGE = 'mx-auto max-w-7xl space-y-6 px-5 py-8 sm:px-8 sm:py-10';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-2">
      <div className="min-w-0">
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
