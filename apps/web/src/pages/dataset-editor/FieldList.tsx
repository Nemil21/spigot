import { canFilter, rightsFlagText, type DatasetField, type FieldValue } from './model';

export interface FieldListProps {
  /** Fields with the owner's edits applied. */
  fields: readonly DatasetField[];
  /** False for a LIVE (or unpublished) dataset: its served schema changes only via a new approve. */
  editable: boolean;
  onToggleVisible: (name: string) => void;
  onToggleFilterable: (name: string) => void;
}

function exampleText(v: FieldValue): string {
  if (v === null) return '–';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function NullRateBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-xs text-muted">–</span>;
  const pct = Math.round(rate * 1000) / 10;
  const tone = rate > 0.4 ? 'bg-danger' : rate > 0.1 ? 'bg-warning' : 'bg-positive';
  return (
    <div className="flex items-center gap-2" title={`${pct}% of sample pages had no value`}>
      <div
        role="meter"
        aria-label="Null rate"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span className="w-10 text-xs tabular-nums text-muted">{pct}%</span>
    </div>
  );
}

/**
 * W06 field list (screens.md §W06): name, type, example, null-rate bar, visible toggle, PII badge,
 * rights flag, and a filterable chip (disabled for hidden fields and types that can't filter).
 */
export function FieldList({
  fields,
  editable,
  onToggleVisible,
  onToggleFilterable,
}: FieldListProps) {
  return (
    <ul className="divide-y divide-line" aria-label="Fields">
      {fields.map((f) => {
        const filterOk = editable && f.visible && canFilter(f.type);
        const filterOn = f.visible && f.filterable.length > 0;
        return (
          <li
            key={f.name}
            data-field={f.name}
            data-visible={String(f.visible)}
            className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3"
          >
            <label className="mt-0.5 inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                role="switch"
                checked={f.visible}
                disabled={!editable}
                onChange={() => onToggleVisible(f.name)}
                aria-label={`Sell ${f.name}`}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`font-mono text-sm font-medium ${
                    f.visible ? 'text-ink' : 'text-muted line-through'
                  }`}
                >
                  {f.name}
                </span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-body">
                  {f.type}
                </span>
                {f.pii && (
                  <span
                    className="rounded-full bg-warning-tint px-2 py-0.5 text-[11px] font-medium text-warning"
                    data-badge="pii"
                    title="Looks like personal contact data: hidden by default"
                  >
                    PII
                  </span>
                )}
                {!f.visible && (
                  <span className="text-[11px] text-muted" data-hidden-label="">
                    Hidden from buyers
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted" title={exampleText(f.example)}>
                e.g. {exampleText(f.example)}
              </p>
              {f.rightsFlag && (
                <p className="mt-1 text-xs text-danger" data-badge="rights">
                  {rightsFlagText(f)}
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <NullRateBar rate={f.nullRate} />
              <button
                type="button"
                aria-pressed={filterOn}
                disabled={!filterOk}
                onClick={() => onToggleFilterable(f.name)}
                aria-label={`Filterable: ${f.name}`}
                title={
                  !f.visible
                    ? 'Hidden fields can’t be filtered'
                    : canFilter(f.type)
                      ? filterOn
                        ? `Buyers can filter with ${f.filterable.join(', ')}`
                        : 'Let buyers filter on this field'
                      : `${f.type} fields can’t be filtered`
                }
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                  filterOn
                    ? 'border-accent bg-accent-tint text-accent'
                    : 'border-line bg-surface text-body'
                }`}
              >
                {filterOn ? `Filter: ${f.filterable.join(' ')}` : 'Filter'}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
