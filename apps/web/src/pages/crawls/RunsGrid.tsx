import type { ColDef, GetRowIdParams, ICellRendererParams } from 'ag-grid-community';
import { useMemo } from 'react';
import { SpigotGrid } from '../../grid';
import { Pill } from '../onboarding/kit';
import {
  aiCallsNote,
  formatCount,
  formatDuration,
  formatWhen,
  runDurationMs,
  runStatusLabel,
  runStatusTone,
  triggerLabel,
  type CrawlRun,
} from './model';

export interface RunsGridProps {
  /** Drawn inside a panel (no grid frame). */
  bare?: boolean;
  runs: CrawlRun[];
  now: number;
  onOpen: (run: CrawlRun) => void;
}

type Cell = ICellRendererParams<CrawlRun>;

function AiCallsCell({ run }: { run: CrawlRun }) {
  const note = aiCallsNote(run);
  return (
    <span
      data-ai-calls={run.aiCalls}
      className={`tabular-nums ${run.aiCalls === 0 ? 'text-positive' : note === 'unexpected' ? 'text-danger' : 'text-ink'}`}
    >
      {formatCount(run.aiCalls)}
      {note && <span className="ml-1 text-xs text-muted">({note})</span>}
    </span>
  );
}

const count = (
  field: keyof CrawlRun,
  headerName: string,
  signed?: '+' | '−',
): ColDef<CrawlRun> => ({
  headerName,
  field,
  type: 'rightAligned',
  width: 120,
  valueFormatter: (p) => {
    const n = p.value as number;
    return signed && n > 0 ? `${signed}${formatCount(n)}` : formatCount(n);
  },
});

/**
 * W10 runs table (screens.md §W10): trigger, pages fetched / not modified / failed, records
 * added / updated / removed, AI calls, duration, status. Rows are keyed by run id, so a live
 * progress frame updates its row in place.
 */
export function RunsGrid({ runs, now, onOpen, bare = false }: RunsGridProps) {
  const columns = useMemo<ColDef<CrawlRun>[]>(
    () => [
      {
        headerName: 'Started',
        colId: 'started',
        minWidth: 150,
        valueGetter: (p) => (p.data ? formatWhen(p.data.startedAt ?? p.data.createdAt) : ''),
      },
      {
        headerName: 'Trigger',
        field: 'trigger',
        width: 130,
        valueFormatter: (p) => (p.data ? triggerLabel(p.data.trigger) : ''),
      },
      {
        headerName: 'Status',
        field: 'status',
        width: 130,
        cellRenderer: (p: Cell) =>
          p.data ? (
            <Pill tone={runStatusTone(p.data.status)}>{runStatusLabel(p.data.status)}</Pill>
          ) : null,
        tooltipValueGetter: (p) => p.data?.error ?? undefined,
      },
      count('pagesFetched', 'Fetched'),
      count('pagesNotModified', 'Not modified'),
      count('pagesFailed', 'Failed'),
      count('recordsAdded', 'Added', '+'),
      count('recordsUpdated', 'Updated'),
      count('recordsRemoved', 'Removed', '−'),
      {
        headerName: 'AI calls',
        field: 'aiCalls',
        type: 'rightAligned',
        minWidth: 170,
        cellRenderer: (p: Cell) => (p.data ? <AiCallsCell run={p.data} /> : null),
      },
      {
        headerName: 'Duration',
        colId: 'duration',
        width: 120,
        type: 'rightAligned',
        valueGetter: (p) => (p.data ? formatDuration(runDurationMs(p.data, now)) : ''),
      },
      {
        headerName: '',
        colId: 'open',
        width: 90,
        sortable: false,
        cellRenderer: (p: Cell) =>
          p.data ? (
            <button
              type="button"
              className="text-sm font-medium text-accent hover:underline"
              aria-label={`Open run ${p.data.id}`}
              onClick={() => onOpen(p.data!)}
            >
              Open
            </button>
          ) : null,
      },
    ],
    [now, onOpen],
  );

  return (
    <SpigotGrid<CrawlRun>
      bare={bare}
      height={Math.min(560, 56 + Math.max(runs.length, 3) * 42)}
      rowData={runs}
      columnDefs={columns}
      defaultColDef={{ sortable: false, resizable: true }}
      getRowId={(p: GetRowIdParams<CrawlRun>) => p.data.id}
      suppressColumnVirtualisation
      suppressRowVirtualisation
      suppressCellFocus
    />
  );
}
