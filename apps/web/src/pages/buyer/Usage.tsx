import { formatCount } from '@spigot/shared/money';
import type { ColDef, GetRowIdParams, ICellRendererParams } from 'ag-grid-community';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api as defaultApi, type ApiClient } from '../../api/client';
import { EmptyState, ErrorBanner, Money, SimChip, Skeleton } from '../../components';
import { SpigotGrid } from '../../grid';
import { paths } from '../../routes';
import { CallDrawer, CLAIMS_PATH } from './CallDrawer';
import { ClaimsList } from './ClaimsList';
import { RefundCard } from './RefundCard';
import { formatWhen, type BuyerClaim, type UsagePage, type UsageRow } from './usageModel';

export const USAGE_PATH = '/api/buyer/usage';

export const W12_COPY = {
  empty: 'No calls yet. Create an API key and point your agent at Spigot.',
} as const;

export interface UsageScreenProps {
  client?: ApiClient;
  /** Clock for the 7-day claim window (tests). */
  now?: () => number;
  refundPollMs?: number;
  newIdempotencyKey?: () => string;
}

type Cell = ICellRendererParams<UsageRow>;

/**
 * W12 Buyer usage & claims (screens.md §W12; features/07, 10; SP-050). Every call (time,
 * dataset, endpoint, records, charged, channel, replay flag) in AG Grid with "Load more" paging;
 * a per-call drawer with "Report a bad record"; the buyer's claims; and "Refund unused balance to
 * PayPal" with the allowed amount. States: empty, claim auto-credited, claim pending the
 * publisher, refund requested / completed.
 */
export function UsageScreen({
  client = defaultApi,
  now,
  refundPollMs,
  newIdempotencyKey,
}: UsageScreenProps) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [claims, setClaims] = useState<BuyerClaim[] | null>(null);
  const [claimsError, setClaimsError] = useState<unknown>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const loadFirst = useCallback(async () => {
    try {
      const page = await client.get<UsagePage>(USAGE_PATH);
      setRows(page.rows);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [client]);

  const loadClaims = useCallback(async () => {
    try {
      const r = await client.get<{ claims: BuyerClaim[] }>(CLAIMS_PATH);
      setClaims(r.claims);
      setClaimsError(null);
    } catch (err) {
      setClaimsError(err);
    }
  }, [client]);

  useEffect(() => {
    void loadFirst();
    void loadClaims();
  }, [loadFirst, loadClaims, attempt]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.get<UsagePage>(
        `${USAGE_PATH}?cursor=${encodeURIComponent(nextCursor)}`,
      );
      setRows((r) => [...(r ?? []), ...page.rows]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  // A credit changes the call's credited amount: re-read the first page and the claims.
  const onClaimed = useCallback(() => {
    void loadClaims();
    void loadFirst();
  }, [loadClaims, loadFirst]);
  const onClose = useCallback(() => setOpenCall(null), []);

  const columns = useMemo<ColDef<UsageRow>[]>(
    () => [
      {
        headerName: 'Time',
        colId: 'time',
        minWidth: 150,
        valueGetter: (p) => (p.data ? formatWhen(p.data.time) : ''),
      },
      {
        headerName: 'Dataset',
        colId: 'dataset',
        minWidth: 170,
        cellRenderer: (p: Cell) =>
          p.data ? (
            <span className="flex items-center gap-2">
              {p.data.dataset ? `${p.data.dataset.site} / ${p.data.dataset.slug}` : '—'}
              {p.data.isSimulated && <SimChip />}
            </span>
          ) : null,
      },
      { headerName: 'Endpoint', field: 'endpoint', minWidth: 140 },
      {
        headerName: 'Records',
        colId: 'records',
        type: 'rightAligned',
        width: 110,
        valueGetter: (p) =>
          p.data
            ? p.data.records !== null
              ? formatCount(p.data.records)
              : p.data.changes !== null
                ? `${formatCount(p.data.changes)} changes`
                : '—'
            : '',
      },
      {
        headerName: 'Charged',
        colId: 'charged',
        type: 'rightAligned',
        minWidth: 150,
        cellRenderer: (p: Cell) =>
          p.data ? (
            <span className="flex flex-col items-end leading-tight">
              {p.data.chargedMicros > 0 ? (
                <Money micros={p.data.chargedMicros} />
              ) : (
                <span className="text-muted">Not charged</span>
              )}
              {p.data.creditedMicros > 0 && (
                <span className="text-xs text-positive">
                  <Money micros={p.data.creditedMicros} word="credited" />
                </span>
              )}
            </span>
          ) : null,
      },
      { headerName: 'Channel', field: 'channel', width: 100 },
      {
        headerName: 'Replay',
        colId: 'replay',
        width: 110,
        headerTooltip: 'Retrying with the same Idempotency-Key returns the stored response free',
        valueGetter: (p) => (p.data?.replayable ? 'Replayable' : ''),
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
              aria-label={`Open call ${p.data.id}`}
              onClick={() => setOpenCall(p.data!.id)}
            >
              Open
            </button>
          ) : null,
      },
    ],
    [],
  );

  if (rows === null && error !== null) {
    return (
      <Frame>
        <ErrorBanner error={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Frame>
    );
  }

  return (
    <Frame>
      {error !== null && rows !== null && (
        <ErrorBanner error={error} title="Couldn't load more calls." />
      )}
      <section aria-labelledby="calls-title" className="space-y-3">
        <h2 id="calls-title" className="text-lg font-semibold text-ink">
          Calls
        </h2>
        {rows === null ? (
          <Skeleton className="block h-64 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            message={W12_COPY.empty}
            action={{ label: 'Get an API key', to: paths.buyerPortal }}
          />
        ) : (
          <>
            <SpigotGrid<UsageRow>
              height={Math.min(560, 56 + Math.max(rows.length, 3) * 42)}
              rowData={rows}
              columnDefs={columns}
              defaultColDef={{ sortable: false, resizable: true }}
              getRowId={(p: GetRowIdParams<UsageRow>) => p.data.id}
              suppressColumnVirtualisation
              suppressRowVirtualisation
              suppressCellFocus
            />
            {nextCursor && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {claimsError !== null && claims === null ? (
          <ErrorBanner
            error={claimsError}
            title="Claims didn't load."
            onRetry={() => void loadClaims()}
          />
        ) : claims === null ? (
          <Skeleton className="block h-32 w-full" />
        ) : (
          <ClaimsList claims={claims} onOpenCall={setOpenCall} />
        )}
        <RefundCard
          client={client}
          onBalanceChanged={() => void loadFirst()}
          {...(refundPollMs !== undefined ? { pollMs: refundPollMs } : {})}
          {...(newIdempotencyKey ? { newKey: newIdempotencyKey } : {})}
        />
      </div>

      {openCall && (
        <CallDrawer
          callId={openCall}
          client={client}
          claims={claims ?? []}
          onClaimed={onClaimed}
          onClose={onClose}
          {...(now ? { now } : {})}
        />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-6" data-screen="W12">
      <h1 className="text-2xl font-semibold text-ink">Usage and claims</h1>
      {children}
    </div>
  );
}

export default function UsagePage() {
  return <UsageScreen />;
}
