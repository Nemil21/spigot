import { formatCount } from '@spigot/shared/money';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  RowClickedEvent,
  RowNode,
} from 'ag-grid-community';
import { useEffect, useMemo, useRef } from 'react';
import { Money, SimChip } from '../components';
import { SpigotGrid } from '../grid';
import { CategoryBadge } from '../overview/CategoryBadge';
import { botLabel, decisionLabel, formatBytes } from '../overview/labels';
import { Sparkline } from '../overview/Sparkline';
import { botRowId, type BotRow } from '../overview/types';

/**
 * W04 "Who's crawling you" (features/13 §1; SP-027b): AG Grid Enterprise, grouped by category,
 * with a 24 h sparkline per bot. Rows go in through `applyTransactionAsync` only, so a live
 * refetch updates the changed rows in place; when `flash` is set those rows flash.
 */
export interface BotsGridProps {
  rows: readonly BotRow[];
  /** Flash the rows this update added or changed (live SSE refetches, not loads or filters). */
  flash: boolean;
  onOpen?: (row: BotRow) => void;
  /** Formats "Last seen"; injectable for tests. */
  now?: () => number;
  height?: number;
}

export interface RowDiff {
  add: BotRow[];
  update: BotRow[];
  remove: BotRow[];
}

/** What changed between two snapshots of the grid rows, keyed by `botRowId`. */
export function diffRows(prev: readonly BotRow[], next: readonly BotRow[]): RowDiff {
  const before = new Map(prev.map((r) => [botRowId(r), r]));
  const add: BotRow[] = [];
  const update: BotRow[] = [];
  for (const r of next) {
    const id = botRowId(r);
    const old = before.get(id);
    before.delete(id);
    if (!old) add.push(r);
    else if (!sameRow(old, r)) update.push(r);
  }
  return { add, update, remove: [...before.values()] };
}

function sameRow(a: BotRow, b: BotRow): boolean {
  return (
    a.hits === b.hits &&
    a.bytes === b.bytes &&
    a.lastSeen === b.lastSeen &&
    a.wouldHavePaid === b.wouldHavePaid &&
    a.hits24h.join() === b.hits24h.join()
  );
}

function lastSeenText(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export function BotsGrid({ rows, flash, onOpen, now = Date.now, height = 460 }: BotsGridProps) {
  const apiRef = useRef<GridApi<BotRow> | null>(null);
  const shown = useRef<readonly BotRow[]>([]);
  const latest = useRef({ rows, flash });
  latest.current = { rows, flash };

  const sync = (api: GridApi<BotRow>, next: readonly BotRow[], doFlash: boolean) => {
    const diff = diffRows(shown.current, next);
    shown.current = next;
    if (!diff.add.length && !diff.update.length && !diff.remove.length) return;
    api.applyTransactionAsync(diff, (res) => {
      if (!doFlash || api.isDestroyed()) return;
      const nodes = [...res.add, ...res.update] as RowNode<BotRow>[];
      if (nodes.length) api.flashCells({ rowNodes: nodes });
    });
  };

  useEffect(() => {
    if (apiRef.current) sync(apiRef.current, rows, flash);
  }, [rows, flash]);

  const columnDefs = useMemo<ColDef<BotRow>[]>(
    () => [
      { field: 'category', rowGroup: true, hide: true },
      {
        headerName: 'Bot',
        field: 'botName',
        valueFormatter: (p) => (p.value ? botLabel(p.value as string) : ''),
        minWidth: 150,
        flex: 1,
      },
      {
        headerName: 'Hits (7 d)',
        field: 'hits',
        aggFunc: 'sum',
        type: 'rightAligned',
        valueFormatter: (p) => (typeof p.value === 'number' ? formatCount(p.value) : ''),
        sort: 'desc',
        width: 110,
      },
      {
        headerName: 'Last 24 h',
        field: 'hits24h',
        sortable: false,
        width: 120,
        cellRenderer: (p: ICellRendererParams<BotRow>) =>
          p.data ? (
            <Sparkline
              points={p.data.hits24h}
              label={`${botLabel(p.data.botName)}: ${formatCount(p.data.hits24h.reduce((a, b) => a + b, 0))} hits in the last 24 h`}
            />
          ) : null,
      },
      {
        headerName: 'Decision',
        field: 'decision',
        valueFormatter: (p) => (p.value ? decisionLabel(p.value as string) : ''),
        width: 140,
      },
      {
        headerName: 'Last seen',
        field: 'lastSeen',
        aggFunc: 'max',
        valueFormatter: (p) => (p.value ? lastSeenText(p.value as string, now()) : ''),
        width: 110,
      },
      {
        headerName: 'Bytes',
        field: 'bytes',
        aggFunc: 'sum',
        type: 'rightAligned',
        valueFormatter: (p) => (typeof p.value === 'number' ? formatBytes(p.value) : ''),
        width: 100,
      },
      {
        headerName: 'Would have paid',
        headerTooltip: 'Estimate: pages sent to your API × records per page × your price',
        field: 'wouldHavePaid',
        aggFunc: 'sum',
        type: 'rightAligned',
        width: 140,
        cellRenderer: (p: ICellRendererParams<BotRow, number>) =>
          typeof p.value === 'number' && p.value > 0 ? (
            <span className="italic text-muted">
              <Money micros={p.value} /> <span className="sr-only">(estimate)</span>
            </span>
          ) : null,
      },
      {
        headerName: '',
        colId: 'sim',
        field: 'isSimulated',
        width: 70,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<BotRow>) =>
          p.data?.isSimulated ? <SimChip /> : null,
      },
    ],
    [now],
  );

  return (
    <SpigotGrid<BotRow>
      height={height}
      columnDefs={columnDefs}
      defaultColDef={{ resizable: true, sortable: true }}
      autoGroupColumnDef={{
        headerName: 'Category',
        minWidth: 190,
        cellRendererParams: {
          suppressCount: false,
          innerRenderer: (p: ICellRendererParams) =>
            typeof p.value === 'string' ? <CategoryBadge category={p.value} /> : null,
        },
      }}
      groupDefaultExpanded={-1}
      groupDisplayType="singleColumn"
      getRowId={(p: GetRowIdParams<BotRow>) => botRowId(p.data)}
      suppressColumnVirtualisation
      suppressAggFuncInHeader
      overlayNoRowsTemplate="No bots in this view."
      onGridReady={(e: GridReadyEvent<BotRow>) => {
        apiRef.current = e.api;
        sync(e.api, latest.current.rows, false);
      }}
      onRowClicked={(e: RowClickedEvent<BotRow>) => {
        if (e.data) onOpen?.(e.data);
      }}
      rowClass="cursor-pointer"
    />
  );
}
