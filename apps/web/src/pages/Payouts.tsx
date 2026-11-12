import { payoutUnclaimedMessage } from '@spigot/shared/copy';
import { formatCents } from '@spigot/shared/money';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api as defaultApi, type ApiClient } from '../api/client';
import { useEventStream, type EventStreamOptions } from '../api/sse';
import { EmptyState, ErrorBanner, Money, PayPalId, Skeleton, SkeletonText } from '../components';
import { paths } from '../routes';
import { PayoutsGrid } from './payouts/PayoutsGrid';
import { RunPayoutModal } from './payouts/RunPayoutModal';
import { StatementDrawer } from './payouts/StatementDrawer';
import {
  INSUFFICIENT_FUNDS_ALERT,
  failureReason,
  nextPayoutLine,
  type PayoutBatch,
  type PayoutItem,
  type PayoutStatements,
  type PublisherPayouts,
  type RunResult,
} from './payouts/model';
import { PAGE, PageHeader, Panel } from './Panel';
import { LABEL } from '../theme/label';

export const EVENTS_URL = '/api/publishers/me/events';
/** While an item is Sent (PENDING) the page re-reads every 15 s, in case an SSE event is missed. */
export const SENT_POLL_MS = 15_000;

type Load = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready' };
type Notice = { tone: 'info' | 'danger'; text: ReactNode } | null;

export interface PayoutsScreenProps {
  client?: ApiClient;
  /** Tests pass a fake EventSource. */
  sse?: EventStreamOptions & { enabled?: boolean };
  pollMs?: number;
}

/**
 * W09 Payouts (screens.md §W09; features/09, 13 §5; SP-031): the next-payout card, the demo's
 * "Run payout now", the batch → item master/detail grid and the statement drawer. SSE
 * `payout.updated` refetches, so a row flips Sent → Paid out without a reload.
 */
export function PayoutsScreen({
  client = defaultApi,
  sse,
  pollMs = SENT_POLL_MS,
}: PayoutsScreenProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [data, setData] = useState<PublisherPayouts | null>(null);
  const [statements, setStatements] = useState<PayoutStatements | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [running, setRunning] = useState(false);
  // Ids only: the drawer reads the current batch and item from `data`, so a refetch (SSE or poll)
  // flips its pill too.
  const [open, setOpen] = useState<{ batchId: string; itemId: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const seq = useRef(0);

  /** Re-read both endpoints; a stale answer (an older request finishing late) is dropped. */
  const refetch = useCallback(async () => {
    const mine = ++seq.current;
    const [payouts, stmts] = await Promise.all([
      client.get<PublisherPayouts>('/api/publishers/me/payouts'),
      client.get<PayoutStatements>('/api/publishers/me/payouts/statements').catch(() => null), // The drawer shows skeletons; the grid still works without SIM chips.
    ]);
    if (mine !== seq.current) return;
    setData(payouts);
    if (stmts) setStatements(stmts);
  }, [client]);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    refetch().then(
      () => live && setLoad({ status: 'ready' }),
      (error: unknown) => live && setLoad({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [refetch, attempt]);

  const quietRefetch = useCallback(() => {
    refetch().catch(() => undefined); // Keep the last rows; the next event or poll tries again.
  }, [refetch]);

  useEventStream(
    EVENTS_URL,
    {
      onEvent: (m) => m.type === 'payout.updated' && quietRefetch(),
      onRefetch: quietRefetch,
    },
    { ...sse, events: ['payout.updated'] },
  );

  const sending = data?.batches.some((b) => b.items.some((i) => i.status === 'PENDING')) ?? false;
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(quietRefetch, pollMs);
    return () => clearInterval(t);
  }, [sending, quietRefetch, pollMs]);

  const keyRef = useRef<string | null>(null);
  const openRun = () => {
    // One idempotency key per confirm dialog: a retry of the same click reuses it.
    keyRef.current = crypto.randomUUID();
    setNotice(null);
    setRunning(true);
  };

  async function runNow() {
    const r = await client.post<RunResult>(
      '/api/publishers/me/payouts/run',
      {},
      {
        idempotencyKey: keyRef.current ?? crypto.randomUUID(),
      },
    );
    if (r.outcome === 'NO_ITEMS' || r.outcome === 'PERIOD_TAKEN') {
      throw new Error(
        'Nothing to pay out right now. New earnings will go out with the next payout.',
      );
    }
    setRunning(false);
    if (r.outcome === 'PENDING') {
      setNotice({
        tone: 'info',
        text: (
          <>
            {r.items[0] ? formatCents(r.items[0].netCents) : 'Your payout'} sent via PayPal. Batch{' '}
            <PayPalId id={r.paypalBatchId} label="PayPal payout batch id" />. It flips to Paid out
            when PayPal confirms.
          </>
        ),
      });
    } else if (r.outcome === 'FAILED') {
      setNotice({
        tone: 'danger',
        text:
          r.errorCode === 'INSUFFICIENT_FUNDS'
            ? `PayPal refused the payout (INSUFFICIENT_FUNDS). ${INSUFFICIENT_FUNDS_ALERT}. The amount is back in your payable balance.`
            : `${failureReason(r.errorCode ?? null)} The amount is back in your payable balance.`,
      });
    } else {
      setNotice({
        tone: 'info',
        text: 'PayPal hasn’t confirmed the batch yet. Spigot retries it with the same batch id, so it is never sent twice.',
      });
    }
    await refetch().catch(() => undefined);
  }

  const closeStatement = useCallback(() => setOpen(null), []);
  const openStatement = useCallback(
    (batch: PayoutBatch, item: PayoutItem) => setOpen({ batchId: batch.id, itemId: item.id }),
    [],
  );

  const openBatch = open ? data?.batches.find((b) => b.id === open.batchId) : undefined;
  const openItem = openBatch?.items.find((i) => i.id === open?.itemId);
  // A refetch that no longer lists the opened item closes the drawer.
  const openGone = open !== null && data !== null && !openItem;
  useEffect(() => {
    if (openGone) setOpen(null);
  }, [openGone]);

  if (load.status === 'error') {
    return (
      <Frame>
        <ErrorBanner error={load.error} onRetry={() => setAttempt((n) => n + 1)} />
      </Frame>
    );
  }

  const ready = load.status === 'ready' && data !== null;
  const newest = data?.batches[0]?.items[0];

  return (
    <Frame>
      <section
        aria-label="Next payout"
        aria-busy={!ready || undefined}
        className="flex flex-wrap items-stretch justify-between gap-5 rounded-lg border border-line bg-surface p-5 sm:p-6"
      >
        <div className="min-w-0">
          {ready ? (
            <p
              className="text-balance text-lg font-semibold tracking-tight text-ink tabular-nums sm:text-xl"
              data-next-payout=""
            >
              {nextPayoutLine(data.next)}
            </p>
          ) : (
            <Skeleton className="h-6 w-96 max-w-full" />
          )}
          <p className="mt-2 max-w-[70ch] text-sm leading-6 text-body">
            Paid out via PayPal every Monday once you have{' '}
            {ready ? formatCents(data.next.thresholdCents) : '…'} payable. Change the PayPal email
            in{' '}
            <Link
              to={paths.settings}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Settings
            </Link>
            ; it applies to the next batch.
          </p>
          {ready && data.next.inFlightCents > 0 && (
            <p className="mt-1 text-sm text-muted">
              <Money cents={data.next.inFlightCents} /> on its way via PayPal.
            </p>
          )}
        </div>
        {ready && data.isDemo && (
          <div className="flex flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-warning/50 bg-warning-tint/40 px-4 py-3 sm:items-end">
            <span className={`${LABEL} text-warning`}>Demo control</span>
            <button
              type="button"
              onClick={openRun}
              className={`h-8 rounded-md bg-accent px-3.5 ${LABEL} text-on-accent transition-colors hover:bg-accent-strong`}
            >
              Run payout now
            </button>
          </div>
        )}
      </section>

      {notice && (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`rounded-lg px-4 py-3 text-sm ${
            notice.tone === 'danger' ? 'bg-danger-tint text-danger' : 'bg-info-tint text-info'
          }`}
        >
          {notice.text}
        </p>
      )}

      {ready && newest && <StatusBanner item={newest} />}

      {!ready ? (
        <div aria-busy="true" className="rounded-lg border border-line bg-surface p-5">
          <SkeletonText lines={4} />
        </div>
      ) : data.batches.length === 0 ? (
        <EmptyState
          message={`No payouts yet. Earnings go out via PayPal every Monday once you have ${formatCents(data.next.thresholdCents)} payable.`}
          action={{ label: 'See earnings', to: paths.earnings }}
        />
      ) : (
        <Panel
          title="PayPal payouts"
          description="One row per weekly batch. Open a batch for its PayPal item, or its statement."
          flush
        >
          <PayoutsGrid
            batches={data.batches}
            statements={statements?.items ?? {}}
            onOpenStatement={openStatement}
          />
        </Panel>
      )}

      {running && data && (
        <RunPayoutModal
          next={data.next}
          statement={statements?.next}
          onConfirm={runNow}
          onClose={() => setRunning(false)}
        />
      )}
      {openBatch && openItem && (
        <StatementDrawer
          batch={openBatch}
          item={openItem}
          statement={statements?.items[openItem.id]}
          onClose={closeStatement}
        />
      )}
    </Frame>
  );
}

/** The newest item's state (screens.md §W09 states): sent (polling), unclaimed, failed. */
function StatusBanner({ item }: { item: PayoutItem }) {
  if (item.status === 'PENDING') {
    return (
      <p role="status" className="rounded-lg bg-info-tint px-4 py-3 text-sm text-info">
        <Money cents={item.netCents} /> sent via PayPal. Checking with PayPal; this flips to Paid
        out when it lands.
      </p>
    );
  }
  if (item.status === 'UNCLAIMED') {
    const email = item.receiverEmail ?? 'your payout email';
    return (
      <p role="alert" className="rounded-lg bg-warning-tint px-4 py-3 text-sm text-warning">
        {payoutUnclaimedMessage({ amountCents: item.netCents, payoutEmail: email })} Log in to
        PayPal with {email} to claim it.
      </p>
    );
  }
  if (item.status === 'FAILED' || item.status === 'RETURNED') {
    return (
      <p role="alert" className="rounded-lg bg-danger-tint px-4 py-3 text-sm text-danger">
        {failureReason(item.errorCode)} <Money cents={item.netCents} /> is back in your payable
        balance; retrying next batch.
      </p>
    );
  }
  return null;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className={PAGE} data-screen="W09">
      <PageHeader title="Payouts" description="Your earnings, sent to you via PayPal Payouts." />
      {children}
    </div>
  );
}

export default function PayoutsPage() {
  return <PayoutsScreen />;
}
