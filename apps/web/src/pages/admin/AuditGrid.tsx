import type { ColDef, GetRowIdParams, ICellRendererParams } from 'ag-grid-community';
import { PayPalId, SimChip } from '../../components';
import { GRID_AUTO_HEIGHT_ROWS } from '../../components/buyer/ui';
import { SpigotGrid, gridTheme } from '../../grid';
import { dataSummary, formatAt, isSimEvent, type AuditEvent } from './model';

/** An id in mono, middle-truncated like `PayPalId`, with the full value in the tooltip. */
function ShortId({ id }: { id: string | null }) {
  if (!id) return <span className="text-muted">—</span>;
  const shown = id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  return (
    <code className="font-mono text-xs text-body select-all" title={id}>
      {shown}
    </code>
  );
}

const columns: ColDef<AuditEvent>[] = [
  {
    headerName: 'When (UTC)',
    field: 'at',
    minWidth: 190,
    valueFormatter: (p) => formatAt(p.value as string),
  },
  {
    headerName: 'Action',
    field: 'action',
    minWidth: 200,
    cellRenderer: (p: ICellRendererParams<AuditEvent>) =>
      p.data ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-ink">{p.data.action}</span>
          {isSimEvent(p.data) && <SimChip />}
        </span>
      ) : null,
  },
  {
    headerName: 'Actor',
    colId: 'actor',
    minWidth: 190,
    valueGetter: (p) => (p.data ? `${p.data.actorType} ${p.data.actorId ?? ''}`.trim() : ''),
    cellRenderer: (p: ICellRendererParams<AuditEvent>) =>
      p.data ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-xs text-muted">{p.data.actorType}</span>
          <ShortId id={p.data.actorId} />
        </span>
      ) : null,
  },
  {
    headerName: 'Publisher',
    field: 'publisherId',
    minWidth: 140,
    cellRenderer: (p: ICellRendererParams<AuditEvent>) => (
      <ShortId id={p.data?.publisherId ?? null} />
    ),
  },
  {
    headerName: 'Entity',
    colId: 'entity',
    minWidth: 190,
    valueGetter: (p) => (p.data ? `${p.data.entity ?? ''} ${p.data.entityId ?? ''}`.trim() : ''),
    cellRenderer: (p: ICellRendererParams<AuditEvent>) =>
      p.data?.entity ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-xs text-muted">{p.data.entity}</span>
          <ShortId id={p.data.entityId} />
        </span>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  {
    headerName: 'PayPal id',
    field: 'paypalId',
    minWidth: 200,
    cellRenderer: (p: ICellRendererParams<AuditEvent>) => <PayPalId id={p.data?.paypalId} />,
  },
  {
    headerName: 'Details',
    colId: 'data',
    minWidth: 260,
    flex: 2,
    valueGetter: (p) => dataSummary(p.data?.data),
    tooltipValueGetter: (p) => (p.data?.data == null ? '' : JSON.stringify(p.data.data, null, 2)),
  },
];

/** The grid sits inside the W14 panel, which draws the frame: no wrapper border or radius. */
const framelessTheme = gridTheme.withParams({ wrapperBorder: false, wrapperBorderRadius: 0 });

const rowId = (p: GetRowIdParams<AuditEvent>) => p.data.id;

/**
 * W14 audit events (features/14 §Audit and ops): newest first, one row per `audit_events` row.
 * SIM rows carry the SIM chip (features/15); the PayPal id has a copy button so it can be pasted
 * into PayPal's own activity search.
 */
export function AuditGrid({ events }: { events: AuditEvent[] }) {
  return (
    <SpigotGrid<AuditEvent>
      rowData={events}
      columnDefs={columns}
      defaultColDef={{ flex: 1, sortable: true, resizable: true, suppressHeaderMenuButton: true }}
      getRowId={rowId}
      theme={framelessTheme}
      // A page of events sizes to its rows (no empty band); longer lists scroll in the grid.
      height={events.length <= GRID_AUTO_HEIGHT_ROWS ? 'auto' : 520}
      domLayout={events.length <= GRID_AUTO_HEIGHT_ROWS ? 'autoHeight' : 'normal'}
      tooltipShowDelay={300}
      // Seven columns: render them all, so the PayPal id is always in the DOM (and findable).
      suppressColumnVirtualisation
    />
  );
}
