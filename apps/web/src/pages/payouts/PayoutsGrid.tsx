import type {
  ColDef,
  GetRowIdParams,
  ICellRendererParams,
  IDetailCellRendererParams,
} from 'ag-grid-community';
import { useMemo } from 'react';
import { Money, PayPalId, SimChip, StatusPill } from '../../components';
import { SpigotGrid } from '../../grid';
import {
  batchAmountCents,
  batchItemStatus,
  failureReason,
  formatDate,
  formatPeriod,
  simChipTooltip,
  type PayoutBatch,
  type PayoutItem,
  type Statement,
} from './model';

export interface PayoutsGridProps {
  batches: PayoutBatch[];
  statements: Record<string, Statement>;
  onOpenStatement: (batch: PayoutBatch, item: PayoutItem) => void;
}

/** A batch row with the SIM share of its item's statement, for the SIM chip. */
interface BatchRow {
  batch: PayoutBatch;
  amountCents: number;
  sim: Statement | null;
}

/** The payout row's SIM chip: the wrapper's tooltip explains it (the chip's own is generic). */
function PayoutSimChip({ statement }: { statement: Statement }) {
  return (
    <span
      title={simChipTooltip(statement)}
      aria-label={simChipTooltip(statement)}
      className="inline-flex items-center leading-4 [&>*]:pointer-events-none"
      data-sim-chip=""
    >
      <SimChip />
    </span>
  );
}

const itemColumns: ColDef<PayoutItem>[] = [
  {
    headerName: 'Item id',
    field: 'id',
    minWidth: 160,
    cellRenderer: (p: ICellRendererParams<PayoutItem>) => (
      <PayPalId id={p.data?.id} label="sender item id" />
    ),
  },
  {
    headerName: 'PayPal item id',
    field: 'paypalItemId',
    minWidth: 160,
    cellRenderer: (p: ICellRendererParams<PayoutItem>) => (
      <PayPalId id={p.data?.paypalItemId} label="PayPal payout item id" />
    ),
  },
  {
    headerName: 'Status',
    field: 'status',
    minWidth: 200,
    cellRenderer: (p: ICellRendererParams<PayoutItem>) =>
      p.data ? <StatusPill kind="payout" status={p.data.status} /> : null,
  },
  {
    headerName: 'Amount',
    field: 'netCents',
    type: 'rightAligned',
    cellRenderer: (p: ICellRendererParams<PayoutItem>) =>
      p.data ? <Money cents={p.data.netCents} /> : null,
  },
  {
    headerName: 'PayPal fee',
    field: 'feeCents',
    type: 'rightAligned',
    cellRenderer: (p: ICellRendererParams<PayoutItem>) =>
      p.data?.feeCents == null ? (
        <span className="text-muted">—</span>
      ) : (
        <Money cents={p.data.feeCents} />
      ),
  },
  { headerName: 'Sent to', field: 'receiverEmail', minWidth: 180 },
  {
    headerName: 'Reason',
    colId: 'reason',
    minWidth: 220,
    flex: 2,
    valueGetter: (p) =>
      p.data && (p.data.status === 'FAILED' || p.data.status === 'RETURNED')
        ? failureReason(p.data.errorCode)
        : '',
    tooltipValueGetter: (p) => p.value as string,
  },
];

/**
 * W09 payouts (features/13 §5): AG Grid master/detail, batch → items. The batch row has the date,
 * the caller's amount, the PayPal batch id (copy), the item's status pill and a SIM chip when the
 * statement includes simulated charges; the detail grid lists the items with their PayPal item
 * ids. Rows are keyed by id, so an SSE refetch flips a pill in place (Sent → Paid out).
 */
export function PayoutsGrid({ batches, statements, onOpenStatement }: PayoutsGridProps) {
  const rows = useMemo<BatchRow[]>(
    () =>
      batches.map((b) => {
        const sims = b.items
          .map((i) => statements[i.id])
          .filter((s): s is Statement => !!s && (s.simGrossMicros !== 0 || s.simRecords !== 0));
        const sim = sims.length
          ? sims.reduce((a, s) => ({
              ...a,
              simGrossMicros: a.simGrossMicros + s.simGrossMicros,
              simRecords: a.simRecords + s.simRecords,
            }))
          : null;
        return { batch: b, amountCents: batchAmountCents(b), sim };
      }),
    [batches, statements],
  );

  const columns = useMemo<ColDef<BatchRow>[]>(
    () => [
      {
        headerName: 'Batch date',
        colId: 'date',
        cellRenderer: 'agGroupCellRenderer',
        valueGetter: (p) => (p.data ? formatDate(p.data.batch.createdAt) : ''),
        minWidth: 170,
      },
      {
        headerName: 'Period',
        colId: 'period',
        valueGetter: (p) =>
          p.data ? formatPeriod(p.data.batch.periodStart, p.data.batch.periodEnd) : '',
        minWidth: 170,
      },
      {
        headerName: 'Amount',
        colId: 'amount',
        type: 'rightAligned',
        valueGetter: (p) => p.data?.amountCents,
        cellRenderer: (p: ICellRendererParams<BatchRow>) =>
          p.data ? <Money cents={p.data.amountCents} /> : null,
      },
      {
        headerName: 'PayPal batch id',
        colId: 'paypalBatchId',
        minWidth: 190,
        valueGetter: (p) => p.data?.batch.paypalBatchId,
        cellRenderer: (p: ICellRendererParams<BatchRow>) => (
          <PayPalId id={p.data?.batch.paypalBatchId} label="PayPal payout batch id" />
        ),
      },
      {
        headerName: 'Status',
        colId: 'status',
        minWidth: 220,
        valueGetter: (p) => (p.data ? batchItemStatus(p.data.batch) : null),
        cellRenderer: (p: ICellRendererParams<BatchRow>) => {
          const status = p.data && batchItemStatus(p.data.batch);
          return (
            <span className="inline-flex items-center gap-2">
              {status && <StatusPill kind="payout" status={status} />}
              {p.data?.sim && <PayoutSimChip statement={p.data.sim} />}
            </span>
          );
        },
      },
      {
        headerName: '',
        colId: 'statement',
        sortable: false,
        minWidth: 120,
        cellRenderer: (p: ICellRendererParams<BatchRow>) => {
          const item = p.data?.batch.items[0];
          if (!p.data || !item) return null;
          return (
            <button
              type="button"
              onClick={() => onOpenStatement(p.data!.batch, item)}
              className="rounded-sm px-1 text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              Statement
            </button>
          );
        },
      },
    ],
    [onOpenStatement],
  );

  const detailParams = useMemo(
    () =>
      ({
        detailGridOptions: {
          columnDefs: itemColumns,
          defaultColDef: { flex: 1, minWidth: 110, sortable: false },
          getRowId: (p: GetRowIdParams<PayoutItem>) => p.data.id,
          domLayout: 'autoHeight',
          suppressMenuHide: false,
          suppressColumnVirtualisation: true,
        },
        getDetailRowData: (p) => p.successCallback(p.data.batch.items),
        // An SSE refetch replaces the batch row; refresh the item rows in place.
        refreshStrategy: 'rows',
      }) satisfies Partial<IDetailCellRendererParams<BatchRow, PayoutItem>>,
    [],
  );

  return (
    <SpigotGrid<BatchRow>
      bare
      height="auto"
      // Size to the batches (a handful a month) instead of a tall empty frame.
      domLayout="autoHeight"
      rowData={rows}
      columnDefs={columns}
      defaultColDef={{ flex: 1, minWidth: 110, sortable: true }}
      getRowId={(p) => p.data.batch.id}
      masterDetail
      detailRowAutoHeight
      // Six columns: render them all (also what lets jsdom tests see every cell).
      suppressColumnVirtualisation
      detailCellRendererParams={detailParams}
      // The newest batch opens on its items, so its PayPal item id and pill are on screen.
      onFirstDataRendered={(e) => e.api.getDisplayedRowAtIndex(0)?.setExpanded(true)}
      tooltipShowDelay={300}
    />
  );
}
