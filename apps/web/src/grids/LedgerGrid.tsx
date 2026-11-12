import { formatMicros } from '@spigot/shared/money';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  ValueFormatterParams,
} from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import type { ApiClient } from '../api/client';
import { PayPalId, SimChip } from '../components';
import { SpigotGrid } from '../grid';
import { paths } from '../routes';

/**
 * W08 ledger tab (SP-030b; features/13 §4 "server-side row model over `ledger_entries`"): one row
 * per entry on the publisher's payable account, newest first, 100 per block. PayPal id cells
 * carry the payout item id (copyable) and link to W09, where the payout lives. Top-ups never post
 * to a publisher's payable account, so no top-up id appears here.
 */

/** `GET /api/publishers/me/ledger` (apps/api/src/reports/ledgerRows.ts). */
export interface LedgerRow {
  id: string;
  txnId: string;
  kind: string;
  memo: string;
  amountMicros: number;
  isSimulated: boolean;
  paypalId: string | null;
  paypalBatchId: string | null;
  ref: { type: string; id: string } | null;
  createdAt: string;
}

export interface LedgerPage {
  rows: LedgerRow[];
  nextCursor: string | null;
}

export const LEDGER_BLOCK = 100;

const KIND_LABEL: Record<string, string> = {
  CHARGE: 'Sale',
  CREDIT: 'Claim credit',
  PAYOUT_SENT: 'Payout',
  PAYOUT_RETURNED: 'Payout returned',
  DEMO_RESET: 'Demo reset',
};

export function ledgerPath(includeSim: boolean, cursor?: string | null): string {
  const qs = new URLSearchParams({ includeSim: String(includeSim) });
  if (cursor) qs.set('cursor', cursor);
  return `/api/publishers/me/ledger?${qs}`;
}

/**
 * AG Grid asks for rows by offset (`startRow`, block-aligned); the API pages by keyset cursor.
 * Block n's cursor is block n−1's `nextCursor`, so a jump ahead (a fast scroll) walks the
 * missing blocks first. Blocks already walked are remembered until the datasource is replaced.
 */
export function createLedgerDatasource(
  client: ApiClient,
  includeSim: boolean,
): IServerSideDatasource<LedgerRow> {
  // cursors[n] = the cursor that fetches block n (block 0 has none).
  const cursors: Array<string | null | undefined> = [null];

  async function fetchBlock(n: number, signal?: AbortSignal): Promise<LedgerPage | 'end'> {
    for (let i = 0; i < n; i++) {
      if (cursors[i + 1] !== undefined) continue;
      const cursor = cursors[i];
      if (cursor === undefined || (i > 0 && cursor === null)) return 'end';
      const page = await client.get<LedgerPage>(ledgerPath(includeSim, cursor), { signal });
      cursors[i + 1] = page.nextCursor;
      if (page.nextCursor === null) return 'end';
    }
    const cursor = cursors[n];
    if (n > 0 && (cursor === null || cursor === undefined)) return 'end';
    const page = await client.get<LedgerPage>(ledgerPath(includeSim, cursor), { signal });
    cursors[n + 1] = page.nextCursor;
    return page;
  }

  return {
    getRows(params: IServerSideGetRowsParams<LedgerRow>) {
      const start = params.request.startRow ?? 0;
      const n = Math.floor(start / LEDGER_BLOCK);
      fetchBlock(n).then(
        (page) => {
          if (page === 'end') {
            params.success({ rowData: [], rowCount: start });
            return;
          }
          params.success({
            rowData: page.rows,
            // Unknown until the last block: AG keeps asking while rows keep coming.
            rowCount: page.nextCursor === null ? start + page.rows.length : undefined,
          });
        },
        () => params.fail(),
      );
    },
  };
}

function PayPalCell({ data }: ICellRendererParams<LedgerRow>) {
  if (!data?.paypalId) return <span className="text-muted">—</span>;
  const to = `${paths.payouts}?item=${encodeURIComponent(data.paypalId)}`;
  return (
    <span className="inline-flex items-center gap-2">
      <PayPalId id={data.paypalId} label="PayPal payout item id" />
      <Link to={to} className="text-xs text-accent underline-offset-2 hover:underline">
        View payout
      </Link>
    </span>
  );
}

const columnDefs: ColDef<LedgerRow>[] = [
  {
    field: 'createdAt',
    headerName: 'Time',
    width: 180,
    valueFormatter: (p: ValueFormatterParams) =>
      p.value ? new Date(p.value as string).toLocaleString('en-US') : '',
  },
  {
    field: 'kind',
    headerName: 'Kind',
    width: 140,
    valueFormatter: (p: ValueFormatterParams) =>
      KIND_LABEL[p.value as string] ?? String(p.value ?? ''),
  },
  { field: 'memo', headerName: 'Memo', flex: 1, minWidth: 220 },
  {
    field: 'amountMicros',
    headerName: 'Amount',
    width: 130,
    type: 'rightAligned',
    cellClass: 'tabular-nums',
    valueFormatter: (p: ValueFormatterParams) =>
      typeof p.value === 'number' ? formatMicros(p.value) : '',
  },
  {
    field: 'isSimulated',
    headerName: 'SIM',
    width: 90,
    cellRenderer: (p: ICellRendererParams<LedgerRow, boolean>) =>
      p.value === true ? <SimChip /> : null,
  },
  { field: 'paypalId', headerName: 'PayPal id', width: 280, cellRenderer: PayPalCell },
];

export interface LedgerGridProps {
  client: ApiClient;
  includeSim: boolean;
  /** Bump to reload the visible blocks (a new charge or payout landed). */
  version?: number;
  height?: number | string;
}

export function LedgerGrid({ client, includeSim, version = 0, height = 440 }: LedgerGridProps) {
  const apiRef = useRef<GridApi<LedgerRow> | null>(null);
  const datasource = useMemo(
    () => createLedgerDatasource(client, includeSim),
    [client, includeSim],
  );

  useEffect(() => {
    apiRef.current?.setGridOption('serverSideDatasource', datasource);
  }, [datasource]);

  // New entries arrive at the top: reload from the first block (cursors are rebuilt).
  useEffect(() => {
    if (version === 0) return;
    apiRef.current?.setGridOption(
      'serverSideDatasource',
      createLedgerDatasource(client, includeSim),
    );
  }, [version, client, includeSim]);

  const onGridReady = useCallback(
    (e: GridReadyEvent<LedgerRow>) => {
      apiRef.current = e.api;
      e.api.setGridOption('serverSideDatasource', datasource);
    },
    [datasource],
  );

  return (
    <SpigotGrid<LedgerRow>
      height={height}
      rowModelType="serverSide"
      cacheBlockSize={LEDGER_BLOCK}
      maxConcurrentDatasourceRequests={1}
      columnDefs={columnDefs}
      defaultColDef={{ resizable: true, sortable: false }}
      getRowId={(p) => p.data.id}
      suppressColumnVirtualisation
      onGridReady={onGridReady}
    />
  );
}
