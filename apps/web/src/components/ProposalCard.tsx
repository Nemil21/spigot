import type { ColDef } from 'ag-grid-community';
import { formatCount } from '@spigot/shared/money';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { SpigotGrid } from '../grid';
import { href } from '../routes';
import { buttonClass } from './Button';
import { Money } from './Money';

/**
 * One W05 proposal card (SP-028; screens.md §W05, features/13 §2): type name and record count,
 * URL pattern, source badge, 4 key fields, field quality bar, suggested price, a tiny AG Grid of
 * the 5 sample rows, agent rationale, Review (→ W06) and Reject.
 *
 * Hidden fields (PII such as `agent_phone`, wire-service credits) never count as key fields and
 * never get a grid column: they're listed under the key fields with a PII / rights badge, so the
 * owner sees they were found and are not for sale.
 */

/** One field of `GET /api/sites/:id/proposals` (SP-014b `FieldView`). */
export interface ProposalField {
  name: string;
  type: string;
  description?: string | null;
  visible: boolean;
  pii: boolean;
  rightsFlag: boolean;
  filterable: string[];
  nullRate: number | null;
  example: unknown;
}

export type SourceBadge = 'JSON-LD' | 'CSS' | 'auto (no AI)';

/** One proposal of `GET /api/sites/:id/proposals` (api.md; SP-014b). */
export interface Proposal {
  datasetId: string;
  schemaVersionId: string;
  typeName: string;
  slug: string;
  records: number;
  /** The template's URL regex (`^/listings/[a-z0-9-]+$`) or a path pattern. */
  templatePattern: string | null;
  /** Long form: "JSON-LD (Apartment, Offer) + 2 CSS fields". */
  source: string;
  sourceBadge: SourceBadge;
  fields: ProposalField[];
  sampleRows: Record<string, unknown>[];
  suggestedPerRecordMicros: number;
  aiRationale: string | null;
}

export const KEY_FIELD_COUNT = 4;

/** For sale by default: visible and neither PII nor rights-flagged. */
export const isSellable = (f: ProposalField) => f.visible && !f.pii && !f.rightsFlag;

/** The first 4 sellable fields, in the agent's order. */
export function keyFields(fields: readonly ProposalField[]): ProposalField[] {
  return fields.filter(isSellable).slice(0, KEY_FIELD_COUNT);
}

/** Fields found but not for sale by default (PII, rights-flagged or hidden). */
export function withheldFields(fields: readonly ProposalField[]): ProposalField[] {
  return fields.filter((f) => !isSellable(f));
}

/**
 * Template regex → the pattern people read: `^/listings/[a-z0-9-]+$` → `/listings/:slug`,
 * `^/open-houses/[0-9]+$` → `/open-houses/:id` (SP-010's `patternsFor`). Anything not starting
 * with `^` is already a display pattern and passes through.
 */
export function displayPattern(pattern: string | null | undefined): string {
  if (!pattern) return '';
  if (!pattern.startsWith('^')) return pattern;
  return pattern
    .slice(1)
    .replace(/\$$/, '')
    .replace(/\[[^\]]*\][+*]/g, (cls) => (cls === '[0-9]+' ? ':id' : ':slug'))
    .replace(/\\(.)/g, '$1');
}

/** "Listing · 2,341" */
export function countLabel(p: Pick<Proposal, 'typeName' | 'records'>): string {
  return `${p.typeName} · ${formatCount(p.records)}`;
}

function exampleText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.map(exampleText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const BADGE_CLASS: Record<SourceBadge, string> = {
  'JSON-LD': 'bg-info-tint text-info',
  CSS: 'bg-accent-tint text-accent-strong',
  'auto (no AI)': 'bg-surface-2 text-body',
};

function Badge({ children, className }: { children: string; className: string }) {
  return (
    <span
      className={`label inline-flex h-5 items-center whitespace-nowrap rounded-xs px-1.5 text-2xs ${className}`}
    >
      {children}
    </span>
  );
}

/** Filled on share of sample pages: ≥ 95 % good, ≥ 70 % patchy, else poor. */
function fillTone(fill: number): string {
  return fill >= 0.95 ? 'bg-positive' : fill >= 0.7 ? 'bg-warning' : 'bg-danger';
}

const railLabel = 'label text-2xs text-muted';

/** One bar per field; its height is the share of sample pages where the field had a value. */
export function FieldQualityBar({ fields }: { fields: readonly ProposalField[] }) {
  const measured = fields.filter((f) => f.nullRate !== null);
  const full = measured.filter((f) => (f.nullRate ?? 0) === 0).length;
  const label = measured.length
    ? `${full} of ${measured.length} fields filled on every sample page`
    : 'Field quality not measured yet';
  return (
    <div>
      <p className={railLabel}>Field quality</p>
      <div className="mt-2 flex h-7 items-end gap-[3px]" role="img" aria-label={label}>
        {measured.map((f) => {
          const fill = 1 - (f.nullRate ?? 0);
          return (
            <span
              key={f.name}
              title={`${f.name}: ${Math.round(fill * 100)}% filled`}
              data-field={f.name}
              className="flex h-full w-2.5 items-end overflow-hidden rounded-[2px] bg-surface-2"
            >
              <span
                className={`block w-full ${fillTone(fill)}`}
                style={{ height: `${Math.max(fill * 100, 8)}%` }}
              />
            </span>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-5 text-body">{label}</p>
    </div>
  );
}

export interface ProposalCardProps {
  proposal: Proposal;
  onReject: (p: Proposal) => void;
  rejecting?: boolean;
  /** Inline error from a failed reject. */
  error?: string | null;
}

export function ProposalCard({
  proposal: p,
  onReject,
  rejecting = false,
  error,
}: ProposalCardProps) {
  const keys = keyFields(p.fields);
  const withheld = withheldFields(p.fields);
  const columnDefs = useMemo<ColDef<Record<string, unknown>>[]>(
    () =>
      p.fields.filter(isSellable).map((f) => ({
        colId: f.name,
        headerName: f.name,
        valueGetter: (params) => params.data?.[f.name],
        valueFormatter: (params) => exampleText(params.value),
        minWidth: 120,
        flex: 1,
      })),
    [p.fields],
  );
  const headingId = `proposal-${p.datasetId}`;
  const pattern = displayPattern(p.templatePattern);
  const sellable = p.fields.filter(isSellable).length;

  return (
    <article
      aria-labelledby={headingId}
      data-dataset-id={p.datasetId}
      className="overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-10">
        <div className="min-w-0">
          <header>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2
                id={headingId}
                aria-label={countLabel(p)}
                className="text-lg font-semibold tracking-tight text-ink tabular-nums"
              >
                {p.typeName}
                <span className="font-normal text-muted"> · {formatCount(p.records)}</span>
              </h2>
              <span title={p.source}>
                <Badge className={BADGE_CLASS[p.sourceBadge] ?? BADGE_CLASS.CSS}>
                  {p.sourceBadge}
                </Badge>
              </span>
            </div>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
              {pattern && <code className="font-mono text-[13px] text-body">{pattern}</code>}
              <span>
                {sellable} {sellable === 1 ? 'field' : 'fields'} for sale
              </span>
            </p>
          </header>

          <p className={`mt-5 ${railLabel}`}>Key fields</p>
          <dl
            className="mt-2 grid overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 [&>div]:bg-surface"
            style={{ gap: 1 }}
            aria-label="Key fields"
          >
            {keys.map((f) => (
              <div key={f.name} className="min-w-0 px-3 py-2.5">
                <dt className="font-mono text-xs text-muted">{f.name}</dt>
                <dd className="mt-0.5 truncate text-sm text-ink" title={exampleText(f.example)}>
                  {exampleText(f.example)}
                </dd>
              </div>
            ))}
          </dl>

          {withheld.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Not for sale by default">
              {withheld.map((f) => (
                <li
                  key={f.name}
                  className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 py-0.5 pl-2 pr-1 text-xs"
                >
                  <span className="font-mono text-muted line-through">{f.name}</span>
                  <span className="text-muted">hidden</span>
                  {f.pii && <Badge className="bg-warning-tint text-warning">PII</Badge>}
                  {f.rightsFlag && <Badge className="bg-warning-tint text-warning">Rights</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-6 border-line sm:grid-cols-2 lg:grid-cols-1 lg:content-start lg:border-l lg:pl-8">
          <div>
            <p className={railLabel}>Suggested price</p>
            <Money
              micros={p.suggestedPerRecordMicros}
              per1000="records"
              className="mt-1 block whitespace-nowrap text-lg font-semibold tracking-tight text-money"
            />
          </div>
          <FieldQualityBar fields={p.fields} />
        </div>
      </div>

      {p.sampleRows.length > 0 && (
        <div
          className="px-5 pb-5 sm:px-6 sm:pb-6"
          aria-label={`${p.typeName} sample rows`}
          role="region"
        >
          <p className={`mb-2 ${railLabel}`}>
            Sample rows{' '}
            <span className="font-normal">
              · {p.sampleRows.length} of {formatCount(p.records)}
            </span>
          </p>
          <SpigotGrid<Record<string, unknown>>
            rowData={p.sampleRows}
            columnDefs={columnDefs}
            height={Math.min(p.sampleRows.length, 5) * 36 + 42}
            rowHeight={36}
            headerHeight={36}
            suppressMovableColumns
          />
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mx-5 mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger sm:mx-6"
        >
          {error}
        </p>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 sm:px-6">
        {p.aiRationale ? (
          <details className="group min-w-0 basis-full text-sm sm:basis-auto sm:flex-1 [&[open]]:basis-full">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-body hover:text-ink [&::-webkit-details-marker]:hidden">
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="size-3.5 text-muted transition-transform duration-150 group-open:rotate-90"
              >
                <path
                  d="M6 4l4 4-4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Why Claude chose these fields
            </summary>
            <p className="mt-2 max-w-[70ch] whitespace-pre-line pb-1 pl-5 leading-6 text-body">
              {p.aiRationale}
            </p>
          </details>
        ) : (
          <span />
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => onReject(p)}
            disabled={rejecting}
            className={buttonClass({ variant: 'ghost' })}
            aria-label={`Reject ${p.typeName}`}
          >
            {rejecting ? 'Rejecting…' : 'Reject'}
          </button>
          <Link
            to={href('datasetEditor', { datasetId: p.datasetId })}
            className={buttonClass()}
            aria-label={`Review ${p.typeName}`}
          >
            Review
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5">
              <path
                d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </footer>
    </article>
  );
}
