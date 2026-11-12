import { useId } from 'react';
import { buyerLine, priceError, recordNoun } from './model';

export interface PriceInputsProps {
  /** Input text, dollars per 1,000 ("1.50"). */
  perRecord: string;
  perChange: string;
  /** Parsed values (null when the text doesn't parse). */
  perRecordMicros: number | null;
  perChangeMicros: number | null;
  recordCount: number;
  slug: string;
  disabled?: boolean;
  onChange: (next: { perRecord?: string; perChange?: string }) => void;
}

function PriceField({
  label,
  unit,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  error: string | null;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-sm text-muted">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums text-ink disabled:opacity-60"
        />
        <span className="text-sm text-muted">/ 1,000 {unit}</span>
      </div>
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Price per 1,000 records and per 1,000 changes ($0.10–$100), and the live "buyer pays / you get"
 * line computed with `@spigot/shared` money helpers (features/06 §Pricing).
 */
export function PriceInputs(props: PriceInputsProps) {
  const recordErr = priceError(props.perRecordMicros);
  const changeErr = priceError(props.perChangeMicros);
  const line =
    props.perRecordMicros !== null && !recordErr
      ? buyerLine(props.recordCount, props.perRecordMicros, recordNoun(props.slug))
      : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6">
        <PriceField
          label="Per record"
          unit="records"
          value={props.perRecord}
          error={recordErr}
          disabled={props.disabled}
          onChange={(v) => props.onChange({ perRecord: v })}
        />
        <PriceField
          label="Per change"
          unit="changes"
          value={props.perChange}
          error={changeErr}
          disabled={props.disabled}
          onChange={(v) => props.onChange({ perChange: v })}
        />
      </div>
      {line && (
        <p className="text-sm text-body tabular-nums" data-buyer-line="" aria-live="polite">
          {line.text}
        </p>
      )}
      <p className="text-xs text-muted">
        Scraping this yourself: proxies + headless + maintenance. Spigot: one call, always current.
      </p>
    </div>
  );
}
