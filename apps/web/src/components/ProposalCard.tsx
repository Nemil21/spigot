import type { ColDef } from 'ag-grid-community';
import { formatCount } from '@spigot/shared/money';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { SpigotGrid } from '../grid';
import { href } from '../routes';
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
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

/** Filled on share of sample pages: ≥ 95 % good, ≥ 70 % patchy, else poor. */
function fillTone(fill: number): string {
  return fill >= 0.95 ? 'bg-positive' : fill >= 0.7 ? 'bg-warning' : 'bg-danger';
}

/** One bar per field; its height is the share of sample pages where the field had a value. */
export function FieldQualityBar({ fields }: { fields: readonly ProposalField[] }) {
  const measured = fields.filter((f) => f.nullRate !== null);
  const full = measured.filter((f) => (f.nullRate ?? 0) === 0).length;
  const label = measured.length
    ? `${full} of ${measured.length} fields filled on every sample page`
    : 'Field quality not measured yet';
  return (
    <div>
      <p className="text-xs font-medium text-muted">Field quality</p>
      <div className="mt-1 flex h-6 items-end gap-0.5" role="img" aria-label={label}>
        {measured.map((f) => {
          const fill = 1 - (f.nullRate ?? 0);
          return (
            <span
              key={f.name}
              title={`${f.name}: ${Math.round(fill * 100)}% filled`}
              data-field={f.name}
              className="flex h-full w-2 items-end rounded-sm bg-surface-2"
            >
              <span
                className={`block w-full rounded-sm ${fillTone(fill)}`}
                style={{ height: `${Math.max(fill * 100, 8)}%` }}
              />
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted">{label}</p>
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
        minWidth: 110,
        flex: 1,
      })),
    [p.fields],
  );
  const headingId = `proposal-${p.datasetId}`;
  const pattern = displayPattern(p.templatePattern);

  return (
    <article
      aria-labelledby={headingId}
      data-dataset-id={p.datasetId}
      className="rounded-lg border border-line bg-surface p-7 shadow-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id={headingId}
            className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-ink"
          >
            {countLabel(p)}
          </h2>
          {pattern && <code className="mt-1 block text-sm text-muted">{pattern}</code>}
        </div>
        <span title={p.source}>
          <Badge className={BADGE_CLASS[p.sourceBadge] ?? BADGE_CLASS.CSS}>{p.sourceBadge}</Badge>
        </span>
      </header>

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <p className="text-[11px] font-medium tracking-[0.08em] text-muted uppercase">
            Key fields
          </p>
          <dl
            className="mt-2 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4"
            aria-label="Key fields"
          >
            {keys.map((f) => (
              <div
                key={f.name}
                className="min-w-0 rounded-[10px] border border-line bg-surface-2/60 px-3 py-2.5"
              >
                <dt className="font-mono text-xs text-accent">{f.name}</dt>
                <dd className="truncate text-body" title={exampleText(f.example)}>
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
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs"
                >
                  <span className="font-mono text-muted line-through">{f.name}</span>
                  {f.pii && <Badge className="bg-warning-tint text-warning">PII</Badge>}
                  {f.rightsFlag && <Badge className="bg-warning-tint text-warning">Rights</Badge>}
                  <span className="text-muted">hidden</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-3 md:w-48">
          <FieldQualityBar fields={p.fields} />
          <div>
            <p className="text-xs font-medium text-muted">Suggested price</p>
            <Money
              micros={p.suggestedPerRecordMicros}
              per1000="records"
              className="text-sm font-medium text-money"
            />
          </div>
        </div>
      </div>

      {p.sampleRows.length > 0 && (
        <div className="mt-4" aria-label={`${p.typeName} sample rows`} role="region">
          <SpigotGrid<Record<string, unknown>>
            rowData={p.sampleRows}
            columnDefs={columnDefs}
            height={Math.min(p.sampleRows.length, 5) * 32 + 40}
            rowHeight={32}
            headerHeight={32}
            suppressMovableColumns
          />
        </div>
      )}

      {p.aiRationale && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Why Claude chose these fields</summary>
          <p className="mt-2 whitespace-pre-line text-body">{p.aiRationale}</p>
        </details>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      <footer className="mt-4 flex gap-2">
        <Link
          to={href('datasetEditor', { datasetId: p.datasetId })}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong"
          aria-label={`Review ${p.typeName}`}
        >
          Review
        </Link>
        <button
          type="button"
          onClick={() => onReject(p)}
          disabled={rejecting}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-body hover:bg-surface-2 disabled:opacity-60"
          aria-label={`Reject ${p.typeName}`}
        >
          {rejecting ? 'Rejecting…' : 'Reject'}
        </button>
      </footer>
    </article>
  );
}
