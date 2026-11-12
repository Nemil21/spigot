import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton';

/**
 * One KPI tile (W04, W08). `value` is usually a `<Money>` or a count; `hint` sits under it (e.g.
 * "incl. $12.40 SIM"). While loading the value is a skeleton, never a spinner.
 */
export function Kpi({
  label,
  value,
  hint,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      className="flex min-w-0 flex-col rounded-lg border border-line bg-surface px-4 py-3.5 shadow-card"
      aria-busy={loading || undefined}
    >
      <p className="text-sm font-medium text-muted">{label}</p>
      {/* text-xl at 1024 px so five tiles fit the W04 row; text-2xl from 1280 px. */}
      <p className="mt-2 text-xl font-semibold text-ink tabular-nums xl:text-2xl">
        {loading ? <Skeleton className="h-7 w-28" /> : value}
      </p>
      {hint && !loading && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
