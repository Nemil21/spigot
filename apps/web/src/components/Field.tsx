import type { ReactNode } from 'react';

/** Text input / select / textarea look: 36 px tall, hairline border, focus ring in the accent. */
export const inputClass =
  'block h-9 w-full rounded-md border border-border bg-surface px-3 text-base text-ink shadow-card ' +
  'transition-[border-color,box-shadow] duration-150 placeholder:text-muted ' +
  'hover:border-muted/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger aria-invalid:ring-danger/15';

/** Label, control, optional hint and error, stacked. Pass the control's id as `htmlFor`. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-ink" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && !error && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
