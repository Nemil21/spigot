import { formatCount, formatMicros } from '@spigot/shared/money';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  IRowNode,
  ProcessCellForExportParams,
  RowClickedEvent,
  ValueFormatterParams,
} from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SimChip } from '../components';
import { SpigotGrid } from '../grid';
import type { Channel, EarningsGridRow } from '../pages/earningsData';

/**
 * W08 earnings grid (SP-030b; features/13 §4): AG Grid row grouping Buyer → Dataset with REST /
 * MCP leaves, sum aggregations and a grand-total row (equal to the KPI tiles: both come from the
 * same read), pivot by channel, a SIM chip + set filter, CSV export, and a row flash when a
 * `call.charged` event brings in a new or bigger row.
 */

export interface FlashRequest {
  /** Leaf row ids (`gridRowId`) to flash, with their buyer and dataset group rows. */
  ids: readonly string[];
  /** Bumped per request, so the same ids can flash twice in a row. */
  seq: number;
}

export interface EarningsGridProps {
  rows: EarningsGridRow[];
  pivotMode?: boolean;
  flash?: FlashRequest | null;
  onReady?: (api: GridApi<EarningsGridRow>) => void;
  /** A leaf row was clicked ("open call detail"). */
  onOpenRow?: (row: EarningsGridRow) => void;
  height?: number | string;
}

/** Give up waiting for the rows to be drawn after ~1 s (60 frames) and flash what's there. */
const MAX_FLASH_FRAMES = 60;

const MONEY_FIELDS = new Set(['grossMicros', 'commissionMicros', 'netMicros']);

const money = (p: ValueFormatterParams) =>
  typeof p.value === 'number' ? formatMicros(p.value) : '';
const count = (p: ValueFormatterParams) =>
  typeof p.value === 'number' ? formatCount(p.value) : '';

function ChannelPill({ channel }: { channel: Channel }) {
  const tone = channel === 'MCP' ? 'bg-info-tint text-info' : 'bg-surface-2 text-body';
  return (
    <span
      data-channel={channel}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
      title={
        channel === 'MCP' ? 'Called over MCP (e.g. Claude Desktop)' : 'Called over the REST API'
      }
    >
      {channel}
    </span>
  );
}

/** True when every row under the group is SIM; leaves pass their own flag up. */
function allSim(p: { values: unknown[] }): boolean {
  return p.values.length > 0 && p.values.every((v) => v === true);
}

const columnDefs: ColDef<EarningsGridRow>[] = [
  { field: 'buyer', headerName: 'Buyer', rowGroup: true, hide: true, enableRowGroup: true },
  { field: 'dataset', headerName: 'Dataset', rowGroup: true, hide: true, enableRowGroup: true },
  {
    field: 'channel',
    headerName: 'Channel',
    width: 110,
    pivot: true,
    enablePivot: true,
    enableRowGroup: true,
    filter: 'agSetColumnFilter',
    cellRenderer: (p: ICellRendererParams<EarningsGridRow, Channel>) =>
      p.value ? <ChannelPill channel={p.value} /> : null,
  },
  {
    field: 'isSimulated',
    headerName: 'SIM',
    width: 90,
    aggFunc: allSim,
    filter: 'agSetColumnFilter',
    filterParams: { valueFormatter: (p: ValueFormatterParams) => (p.value ? 'SIM' : 'Real') },
    cellRenderer: (p: ICellRendererParams<EarningsGridRow, boolean>) =>
      p.value === true ? <SimChip /> : null,
  },
  {
    field: 'calls',
    headerName: 'Calls',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: count,
  },
  {
    field: 'records',
    headerName: 'Records',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: count,
  },
  {
    field: 'changes',
    headerName: 'Changes',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: count,
  },
  {
    field: 'grossMicros',
    headerName: 'Gross',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: money,
  },
  {
    field: 'commissionMicros',
    headerName: 'Commission (20%)',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: money,
  },
  {
    field: 'netMicros',
    headerName: 'Net (yours)',
    aggFunc: 'sum',
    enableValue: true,
    type: 'rightAligned',
    valueFormatter: money,
    cellClass: 'font-semibold',
  },
  { field: 'lastDay', headerName: 'Last sale', aggFunc: 'max', width: 120 },
];

const defaultColDef: ColDef = {
  sortable: true,
  resizable: true,
  enableCellChangeFlash: true,
  cellClass: 'tabular-nums',
};

const autoGroupColumnDef: ColDef<EarningsGridRow> = {
  headerName: 'Buyer / Dataset',
  minWidth: 260,
  cellRendererParams: { suppressCount: true },
};

/** A leaf and its group rows, so a new MCP call lights up its buyer and dataset too. */
function withAncestors(node: IRowNode | undefined): IRowNode[] {
  const out: IRowNode[] = [];
  for (let n = node; n && n.level >= 0; n = n.parent ?? undefined) out.push(n);
  return out;
}

export function EarningsGrid({
  rows,
  pivotMode = false,
  flash = null,
  onReady,
  onOpenRow,
  height = 440,
}: EarningsGridProps) {
  const apiRef = useRef<GridApi<EarningsGridRow> | null>(null);
  const pending = useRef<FlashRequest | null>(null);

  const flushFlash = useCallback(() => {
    const api = apiRef.current;
    const req = pending.current;
    if (!api || !req) return;
    const nodes = req.ids.map((id) => api.getRowNode(id));
    // Rows still being applied: wait for onRowDataUpdated.
    if (nodes.some((n) => !n)) return;
    pending.current = null;
    // A brand-new row has no cells yet and flashCells only touches drawn cells. AG draws it a
    // frame or more later (more on a slow machine), so wait until every row is drawn.
    const rowNodes = nodes.flatMap(withAncestors);
    let frames = 0;
    const tryFlash = () => {
      if (api.isDestroyed()) return;
      const drawn = new Set(api.getRenderedNodes());
      if (rowNodes.every((n) => drawn.has(n)) || ++frames > MAX_FLASH_FRAMES) {
        // Draw cycles finish within this frame; flash right after.
        setTimeout(() => !api.isDestroyed() && api.flashCells({ rowNodes }), 0);
        return;
      }
      requestAnimationFrame(tryFlash);
    };
    requestAnimationFrame(tryFlash);
  }, []);

  useEffect(() => {
    if (!flash || flash.ids.length === 0) return;
    pending.current = flash;
    flushFlash();
  }, [flash, flushFlash]);

  const onGridReady = useCallback(
    (e: GridReadyEvent<EarningsGridRow>) => {
      apiRef.current = e.api;
      onReady?.(e.api);
      flushFlash();
    },
    [onReady, flushFlash],
  );

  const onRowClicked = useCallback(
    (e: RowClickedEvent<EarningsGridRow>) => {
      if (e.data && !e.node.group) onOpenRow?.(e.data);
    },
    [onOpenRow],
  );

  const getRowId = useMemo(() => (p: { data: EarningsGridRow }) => p.data.rowId, []);

  return (
    <SpigotGrid<EarningsGridRow>
      height={height}
      rowData={rows}
      columnDefs={columnDefs}
      defaultColDef={defaultColDef}
      autoGroupColumnDef={autoGroupColumnDef}
      getRowId={getRowId}
      groupDefaultExpanded={-1}
      grandTotalRow="bottom"
      pivotMode={pivotMode}
      suppressAggFuncInHeader
      suppressColumnVirtualisation
      // Buyers × datasets × channels stays small; every row in the DOM keeps flashes visible.
      suppressRowVirtualisation
      onGridReady={onGridReady}
      onRowDataUpdated={flushFlash}
      onRowClicked={onRowClicked}
      rowClassRules={{ 'cursor-pointer': (p) => !p.node.group }}
    />
  );
}

/** Money as plain dollars (6 dp) and counts as plain numbers, so the CSV sums in a spreadsheet. */
function exportCell(p: ProcessCellForExportParams): string {
  const field = p.column.getColDef().field ?? '';
  if (typeof p.value === 'number' && MONEY_FIELDS.has(field))
    return (p.value / 1_000_000).toFixed(6);
  if (field === 'isSimulated') return p.value === true ? 'SIM' : '';
  return p.value == null ? '' : String(p.value);
}

export const EARNINGS_CSV_FILE = 'spigot-earnings.csv';

/** "Export CSV": what's on screen (grouping, filters, sort), money in dollars. */
export function exportEarningsCsv(api: GridApi<EarningsGridRow>): void {
  const csv = api.getDataAsCsv({ processCellCallback: exportCell }) ?? '';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = EARNINGS_CSV_FILE;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
