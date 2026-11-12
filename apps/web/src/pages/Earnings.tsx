import { formatCount, formatMicros } from '@spigot/shared/money';
import type { GridApi } from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api as defaultApi, type ApiClient } from '../api/client';
import { useEventStream, type EventStreamStatus } from '../api/sse';
import { EmptyState, ErrorBanner, Kpi, Money, Skeleton } from '../components';
import { EarningsBars } from '../charts/EarningsBars';
import { EarningsGrid, exportEarningsCsv, type FlashRequest } from '../grids/EarningsGrid';
import { LedgerGrid } from '../grids/LedgerGrid';
import { paths } from '../routes';
import { ClaimsTab } from './ClaimsTab';
import {
  changedRowIds,
  earningsPath,
  simGrossMicros,
  toBarData,
  toGridRows,
  type Earnings,
  type EarningsGridRow,
} from './earningsData';

/**
 * W08 Earnings (screens.md §W08; features/13 §4; SP-030b). KPI tiles, stacked bars per day by
 * dataset, the grouped AG Grid (Buyer → Dataset, REST / MCP leaves) and the ledger tab. A
 * `call.charged` event refetches at once and flashes the new or changed rows, so a Claude Desktop
 * call shows up as a flashing MCP row well inside 2 s.
 */

export const EVENTS_PATH = '/api/publishers/me/events';
const LIVE_EVENTS = ['call.charged', 'payout.updated'] as const;

export const W08_COPY = {
  noBuyers: 'No buyers yet.',
  noSite: 'No buyers yet. Publish a dataset and your API goes live.',
} as const;

interface SiteSummary {
  slug: string;
}

export interface EarningsScreenProps {
  client?: ApiClient;
  /** SSE on/off (tests); defaults to on outside fixture mode. */
  streamEnabled?: boolean;
  /** Origin shown in "Your API is live at …"; the API serves this app, so it's ours. */
  origin?: string;
}

type Tab = 'sales' | 'ledger' | 'claims';

const TAB_LABEL: Record<Tab, string> = { sales: 'Sales', ledger: 'Ledger', claims: 'Claims' };

export function EarningsScreen({
  client = defaultApi,
  streamEnabled,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
}: EarningsScreenProps) {
  const [includeSim, setIncludeSim] = useState(true);
  const [data, setData] = useState<Earnings | null>(null);
  const [gridRows, setGridRows] = useState<EarningsGridRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('sales');
  const [pivot, setPivot] = useState(false);
  const [flash, setFlash] = useState<FlashRequest | null>(null);
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const [openRow, setOpenRow] = useState<EarningsGridRow | null>(null);
  const [site, setSite] = useState<SiteSummary | null | undefined>(undefined);
  const gridApi = useRef<GridApi<EarningsGridRow> | null>(null);

  // One read at a time; events during a read queue exactly one more.
  const includeSimRef = useRef(includeSim);
  includeSimRef.current = includeSim;
  const prevRows = useRef<EarningsGridRow[] | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);
  const flashSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    const sim = includeSimRef.current;
    try {
      const next = await client.get<Earnings>(earningsPath(sim));
      if (sim !== includeSimRef.current) {
        again.current = true;
        return;
      }
      const rows = toGridRows(next.rows);
      const changed = changedRowIds(prevRows.current, rows);
      prevRows.current = rows;
      setData(next);
      setGridRows(rows);
      setError(null);
      if (changed.length) setFlash({ ids: changed, seq: ++flashSeq.current });
    } catch (err) {
      setError(err);
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [client]);

  useEffect(() => {
    // A different slice (SIM on/off) is a fresh load: nothing flashes.
    prevRows.current = null;
    void refresh();
  }, [includeSim, refresh]);

  const status = useEventStream(
    EVENTS_PATH,
    {
      onEvent: (m) => {
        if (!(LIVE_EVENTS as readonly string[]).includes(m.type)) return;
        void refresh();
        setLedgerVersion((v) => v + 1);
      },
      onRefetch: () => {
        void refresh();
        setLedgerVersion((v) => v + 1);
      },
    },
    // No EventSource (old or locked-down browser): the page still works, without live updates.
    { events: LIVE_EVENTS, enabled: typeof EventSource === 'undefined' ? false : streamEnabled },
  );

  const empty = data !== null && data.kpis.calls === 0;
  useEffect(() => {
    if (!empty || site !== undefined) return;
    client.get<{ sites: SiteSummary[] }>('/api/sites').then(
      (r) => setSite(r.sites[0] ?? null),
      () => setSite(null),
    );
  }, [empty, site, client]);

  const bars = useMemo(() => toBarData(data?.rows ?? []), [data]);
  const simGross = useMemo(() => simGrossMicros(data?.rows ?? []), [data]);
  const onReady = useCallback((a: GridApi<EarningsGridRow>) => {
    gridApi.current = a;
  }, []);

  if (!data && error) {
    return (
      <Frame status={status}>
        <ErrorBanner error={error} onRetry={() => void refresh()} />
      </Frame>
    );
  }

  const k = data?.kpis;
  const loading = !k;

  return (
    <Frame status={status}>
      {error !== null && data && (
        <ErrorBanner
          error={error}
          title="Couldn't refresh earnings."
          onRetry={() => void refresh()}
        />
      )}

      <section
        aria-label="Earnings totals"
        aria-busy={loading || undefined}
        className="grid grid-cols-3 gap-3 xl:grid-cols-6"
      >
        <Kpi
          label="Gross"
          loading={loading}
          value={k && <Money micros={k.grossMicros} />}
          hint={includeSim && simGross > 0 ? `incl. ${formatMicros(simGross)} SIM` : undefined}
        />
        <Kpi
          label="Spigot commission (20%)"
          loading={loading}
          value={k && <Money micros={k.commissionMicros} />}
        />
        <Kpi
          label="Your earnings"
          loading={loading}
          value={k && <Money micros={k.netMicros} className="text-accent" />}
        />
        <Kpi
          label="Payable now"
          loading={loading}
          value={k && <Money micros={k.payableMicros} />}
          hint="Paid out via PayPal"
        />
        <Kpi
          label="Records sold"
          loading={loading}
          value={k && formatCount(k.recordsSold)}
          hint={k && k.changesSold > 0 ? `+ ${formatCount(k.changesSold)} changes` : undefined}
        />
        <Kpi label="Buyers" loading={loading} value={k && formatCount(k.buyers)} />
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <div role="tablist" aria-label="Earnings views" className="flex gap-1">
          {(['sales', 'ledger', 'claims'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === t ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={includeSim}
            onChange={(e) => setIncludeSim(e.target.checked)}
          />
          Include simulated
        </label>
        {tab === 'sales' && !empty && (
          <>
            <label className="flex items-center gap-2 text-sm text-body">
              <input type="checkbox" checked={pivot} onChange={(e) => setPivot(e.target.checked)} />
              Pivot by channel
            </label>
            <button
              type="button"
              onClick={() => gridApi.current && exportEarningsCsv(gridApi.current)}
              disabled={loading}
              className="ml-auto rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
            >
              Export CSV
            </button>
          </>
        )}
      </div>

      {tab === 'claims' ? (
        // SP-050: open claims with the AI's read; a credit moves payable, so refresh KPIs + ledger.
        <ClaimsTab
          client={client}
          onDecided={() => {
            void refresh();
            setLedgerVersion((v) => v + 1);
          }}
        />
      ) : tab === 'ledger' ? (
        <LedgerGrid client={client} includeSim={includeSim} version={ledgerVersion} />
      ) : loading ? (
        <Skeleton className="block h-64 w-full" />
      ) : empty ? (
        <EmptyNotice site={site} origin={origin} />
      ) : (
        <>
          <EarningsBars bars={bars} />
          <EarningsGrid
            rows={gridRows}
            pivotMode={pivot}
            flash={flash}
            onReady={onReady}
            onOpenRow={setOpenRow}
          />
          {openRow && <RowDetail row={openRow} onClose={() => setOpenRow(null)} />}
        </>
      )}
    </Frame>
  );
}

function Frame({ status, children }: { status: EventStreamStatus; children: React.ReactNode }) {
  return (
    <div className="space-y-6" data-screen="W08">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-ink">Earnings</h1>
        {status === 'open' && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-positive">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-positive" />
            Live
          </span>
        )}
        {status === 'reconnecting' && <span className="text-xs text-muted">Reconnecting…</span>}
      </header>
      {children}
    </div>
  );
}

function EmptyNotice({ site, origin }: { site: SiteSummary | null | undefined; origin: string }) {
  if (site === undefined) return <Skeleton className="block h-32 w-full" />;
  if (site === null) {
    return (
      <EmptyState
        message={W08_COPY.noSite}
        action={{ label: 'Find record types', to: paths.recordTypes }}
      />
    );
  }
  return (
    <EmptyState
      message={`${W08_COPY.noBuyers} Your API is live at ${origin}/v1/${site.slug}.`}
      action={{
        label: 'Open your catalog page',
        onClick: () => window.location.assign(`/c/${encodeURIComponent(site.slug)}`),
      }}
    />
  );
}

/** "Open call detail": the sales behind one leaf (buyer × dataset × channel). */
function RowDetail({ row, onClose }: { row: EarningsGridRow; onClose: () => void }) {
  const items: Array<[string, React.ReactNode]> = [
    ['Calls', formatCount(row.calls)],
    ['Records', formatCount(row.records)],
    ['Changes', formatCount(row.changes)],
    ['Gross', <Money key="g" micros={row.grossMicros} word="charged" />],
    ['Spigot commission', <Money key="c" micros={row.commissionMicros} />],
    ['Your earnings', <Money key="n" micros={row.netMicros} />],
    [
      'Average per call',
      <Money key="a" micros={Math.round(row.grossMicros / Math.max(row.calls, 1))} />,
    ],
    ['Last sale', row.lastDay],
  ];
  return (
    <section
      aria-label="Sales detail"
      className="rounded-lg border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-start justify-between">
        <h2 className="font-semibold text-ink">
          {row.buyer} · {row.dataset} · {row.channel}
          {row.isSimulated ? ' · SIM' : ''}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-ink">
          Close
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-3 text-sm">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function EarningsPage() {
  return <EarningsScreen />;
}
