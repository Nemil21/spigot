import type { ColDef, ICellRendererParams, ValueGetterParams } from 'ag-grid-community';
import type { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useRef } from 'react';
import { SpigotGrid } from '../../grid';
import type { DatasetField, FieldValue, SampleRow } from './model';

/** How a column's cells render (features/13 §3: type → cell renderer). */
export type CellKind = 'money' | 'date' | 'boolean' | 'url' | 'list' | 'number' | 'text';

/** Number fields that hold money, by name (`price_usd`, `rent`, `deposit_cents`). */
const MONEY_NAME = /(^|_)(price|rent|deposit|fee|cost|amount|usd|cents)(_|$)/i;

export function cellKind(field: Pick<DatasetField, 'name' | 'type'>): CellKind {
  switch (field.type) {
    case 'integer':
    case 'number':
      return MONEY_NAME.test(field.name) ? 'money' : 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'url':
      return 'url';
    case 'string[]':
      return 'list';
    default:
      return 'text';
  }
}

const usd = (fractionDigits: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  });

/** A scraped money value (dollars, or cents when the name says so), e.g. 1850 → "$1,850". */
export function formatMoneyValue(name: string, value: number): string {
  if (/cents/i.test(name)) return usd(2).format(value / 100);
  return usd(Number.isInteger(value) ? 0 : 2).format(value);
}

function formatDateValue(type: string, value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return type === 'date'
    ? d.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : d.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function safeHref(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** One cell, by kind. Hidden columns get their styling from `cellClass`. */
export function SchemaCell({
  field,
  value,
}: {
  field: DatasetField;
  value: FieldValue | undefined;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted">–</span>;
  }
  const kind = cellKind(field);
  if (kind === 'money' && typeof value === 'number') {
    return <span className="tabular-nums">{formatMoneyValue(field.name, value)}</span>;
  }
  if (kind === 'number' && typeof value === 'number') {
    return <span className="tabular-nums">{value.toLocaleString('en-US')}</span>;
  }
  if (kind === 'date' && typeof value === 'string') {
    return <span className="tabular-nums">{formatDateValue(field.type, value)}</span>;
  }
  if (kind === 'boolean' && typeof value === 'boolean') {
    return (
      <span
        data-bool={String(value)}
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
          value ? 'bg-positive-tint text-positive' : 'bg-surface-2 text-body'
        }`}
      >
        {value ? 'Yes' : 'No'}
      </span>
    );
  }
  if (kind === 'url' && typeof value === 'string') {
    const href = safeHref(value);
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:underline"
      >
        {value}
      </a>
    ) : (
      <span>{value}</span>
    );
  }
  if (Array.isArray(value)) return <span>{value.join(', ')}</span>;
  return <span>{String(value)}</span>;
}

export const HIDDEN_CELL_CLASS = 'spigot-hidden-field line-through opacity-50';

/**
 * `columnDefs` generated from `schema_versions.fields` (features/13 §3): one column per field in
 * schema order, a renderer per type, and hidden fields struck through and greyed (still shown:
 * the owner sees what they're holding back).
 */
export function schemaColumnDefs(fields: readonly DatasetField[]): ColDef<SampleRow>[] {
  return fields.map((field) => {
    const hidden = !field.visible;
    const kind = cellKind(field);
    return {
      colId: field.name,
      headerName: hidden ? `${field.name} (hidden)` : field.name,
      headerTooltip: hidden
        ? `${field.name}: hidden from buyers`
        : (field.description ?? field.name),
      valueGetter: (p: ValueGetterParams<SampleRow>) => p.data?.[field.name] ?? null,
      cellRenderer: (p: ICellRendererParams<SampleRow>) => (
        <SchemaCell field={field} value={p.data?.[field.name]} />
      ),
      cellClass: hidden ? HIDDEN_CELL_CLASS : undefined,
      headerClass: hidden ? HIDDEN_CELL_CLASS : undefined,
      type: kind === 'money' || kind === 'number' ? 'rightAligned' : undefined,
      minWidth: kind === 'url' ? 220 : 120,
      sortable: true,
      resizable: true,
      context: { kind, hidden },
    } satisfies ColDef<SampleRow>;
  });
}

export interface SchemaGridProps {
  fields: readonly DatasetField[];
  rows: readonly SampleRow[];
  height?: number;
}

/** The W06 sample-row grid (20 rows). Re-generates its columns the moment a toggle changes. */
export function SchemaGrid({ fields, rows, height = 420 }: SchemaGridProps) {
  const gridRef = useRef<AgGridReact<SampleRow>>(null);
  const columnDefs = useMemo(() => schemaColumnDefs(fields), [fields]);
  const rowData = useMemo(() => [...rows], [rows]);

  // New colDefs change the cell classes; force the rendered cells to pick them up at once.
  useEffect(() => {
    const api = gridRef.current?.api;
    if (api && !api.isDestroyed()) {
      api.refreshHeader();
      api.refreshCells({ force: true });
    }
  }, [columnDefs]);

  return (
    <div data-schema-grid="">
      <SpigotGrid<SampleRow>
        gridRef={gridRef}
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={{ flex: 1 }}
        tooltipShowDelay={300}
        suppressCellFocus
        // A schema has a handful of columns: render them all (hidden ones included).
        suppressColumnVirtualisation
        height={height}
      />
    </div>
  );
}
