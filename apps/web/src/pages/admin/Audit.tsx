import { formatCount } from '@spigot/shared/money';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, api as defaultApi, type ApiClient } from '../../api/client';
import {
  EmptyState,
  ErrorBanner,
  Money,
  PayPalId,
  Skeleton,
  SkeletonText,
  errorMessage,
} from '../../components';
import * as ui from '../../components/buyer/ui';
import { AuditGrid } from './AuditGrid';
import {
  SEARCH_FIELDS,
  auditUrl,
  failedChecks,
  formatAt,
  lastGateHit,
  runOutcomeLine,
  searchError,
  type AdminHealth,
  type AdminRunResult,
  type AuditPage,
  type AuditSearch,
  type LedgerCheckResult,
  type SearchKey,
} from './model';

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; value: T };

const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

export interface AuditScreenProps {
  client?: ApiClient;
}

/**
 * W14 Admin / audit (screens.md §W14; features/14 §Audit and ops; SP-062): find any money event
 * by publisher, buyer or PayPal id, see the ops health tiles, prove the ledger balances (sum = 0)
 * and run the demo payout. Admin only: SP-043 answers 403 to anyone not in `ADMIN_EMAILS`, and
 * the screen then says so instead of showing empty tiles. The search lives in the URL
 * (`?paypalId=…`), so a found row can be linked.
 */
export function AuditScreen({ client = defaultApi }: AuditScreenProps) {
  const [params, setParams] = useSearchParams();
  const search: AuditSearch = {};
  for (const { key } of SEARCH_FIELDS) {
    const v = params.get(key);
    if (v) search[key] = v;
  }
  const searchKey = auditUrl(search);

  const [health, setHealth] = useState<Load<AdminHealth>>({ status: 'loading' });
  const [audit, setAudit] = useState<Load<AuditPage>>({ status: 'loading' });
  const [healthAttempt, setHealthAttempt] = useState(0);
  const [auditAttempt, setAuditAttempt] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const auditSeq = useRef(0);

  const loadHealth = useCallback(() => client.get<AdminHealth>('/admin/health'), [client]);

  useEffect(() => {
    let live = true;
    setHealth((h) => (h.status === 'ready' ? h : { status: 'loading' }));
    loadHealth().then(
      (value) => live && setHealth({ status: 'ready', value }),
      (error: unknown) => live && setHealth({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
  }, [loadHealth, healthAttempt]);

  useEffect(() => {
    const mine = ++auditSeq.current;
    setAudit({ status: 'loading' });
    setMoreError(null);
    client.get<AuditPage>(searchKey).then(
      (value) => mine === auditSeq.current && setAudit({ status: 'ready', value }),
      (error: unknown) => mine === auditSeq.current && setAudit({ status: 'error', error }),
    );
  }, [client, searchKey, auditAttempt]);

  async function loadMore() {
    if (audit.status !== 'ready' || !audit.value.next || moreBusy) return;
    const mine = auditSeq.current;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await client.get<AuditPage>(auditUrl(search, audit.value.next));
      if (mine !== auditSeq.current) return;
      setAudit({
        status: 'ready',
        value: { events: [...audit.value.events, ...page.events], next: page.next },
      });
    } catch (err) {
      if (mine === auditSeq.current) setMoreError(err);
    } finally {
      setMoreBusy(false);
    }
  }

  /** After a payout run: new audit rows and new pending-payout counts. */
  const refreshAll = useCallback(() => {
    setHealthAttempt((n) => n + 1);
    setAuditAttempt((n) => n + 1);
  }, []);

  const forbidden =
    (health.status === 'error' && isForbidden(health.error)) ||
    (audit.status === 'error' && isForbidden(audit.error));
  if (forbidden) {
    return (
      <Frame>
        <div role="alert" className={`${ui.panel} ${ui.panelBody} text-body`}>
          <p className="font-medium text-ink">Admins only.</p>
          <p className="mt-1 text-sm">
            This screen is for Spigot operators. Sign in with an email listed in{' '}
            <code className="font-mono text-xs">ADMIN_EMAILS</code>.
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <HealthSection health={health} onRefresh={() => setHealthAttempt((n) => n + 1)} />

      <section aria-label="Operations" className="grid items-start gap-6 md:grid-cols-2">
        <LedgerCheck client={client} />
        <RunPayout client={client} onDone={refreshAll} />
      </section>

      <section aria-label="Audit events" className={ui.panel}>
        <div className={ui.panelHead}>
          <div>
            <h2 className={ui.panelTitle}>Audit events</h2>
            <p className={ui.panelDesc}>
              Search by a PayPal order, capture, refund or payout id, or by publisher or buyer.
            </p>
          </div>
        </div>
        <SearchForm
          initial={search}
          onSearch={(s) => {
            const next = new URLSearchParams();
            for (const { key } of SEARCH_FIELDS) {
              const v = s[key]?.trim();
              if (v) next.set(key, v);
            }
            setParams(next);
          }}
        />
        {audit.status === 'error' ? (
          <div className={ui.panelBody}>
            <ErrorBanner error={audit.error} onRetry={() => setAuditAttempt((n) => n + 1)} />
          </div>
        ) : audit.status === 'loading' ? (
          <div aria-busy="true" className={ui.panelBody}>
            <SkeletonText lines={4} />
          </div>
        ) : audit.value.events.length === 0 ? (
          <div className={ui.panelBody}>
            {Object.keys(search).length ? (
              <EmptyState
                message="No audit events match this search."
                action={{ label: 'Clear search', onClick: () => setParams(new URLSearchParams()) }}
              />
            ) : (
              <EmptyState
                message="No audit events yet. Run seed:demo or connect a site."
                action={{ label: 'Reload', onClick: () => setAuditAttempt((n) => n + 1) }}
              />
            )}
          </div>
        ) : (
          <>
            <p
              className={`border-b border-line px-5 py-2.5 tabular-nums sm:px-6 ${ui.statLabel}`}
              data-audit-count=""
            >
              {formatCount(audit.value.events.length)} event
              {audit.value.events.length === 1 ? '' : 's'}
              {audit.value.next ? ' shown, newest first' : ', newest first'}
            </p>
            <AuditGrid events={audit.value.events} />
            {(moreError !== null || audit.value.next) && (
              <div className="space-y-3 border-t border-line px-5 py-4 sm:px-6">
                {moreError !== null && <ErrorBanner error={moreError} onRetry={loadMore} />}
                {audit.value.next && (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={moreBusy}
                    className={ui.btnSecondary}
                  >
                    {moreBusy ? 'Loading…' : 'Load older events'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </Frame>
  );
}

function SearchForm({
  initial,
  onSearch,
}: {
  initial: AuditSearch;
  onSearch: (s: AuditSearch) => void;
}) {
  const [values, setValues] = useState<AuditSearch>(initial);
  const [error, setError] = useState<string | null>(null);
  // Back / forward or a "Clear search" changes the URL: show what is being searched.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setValues(JSON.parse(initialKey) as AuditSearch);
    setError(null);
  }, [initialKey]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const err = searchError(values);
    setError(err);
    if (!err) onSearch(values);
  }

  return (
    <form
      role="search"
      aria-label="Search audit events"
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 border-b border-line bg-surface-2/40 px-5 py-4 sm:px-6"
    >
      {SEARCH_FIELDS.map((f) => (
        <label key={f.key} className="flex min-w-48 flex-1 flex-col">
          <span className={ui.statLabel}>{f.label}</span>
          <input
            type="search"
            name={f.key}
            value={values[f.key] ?? ''}
            placeholder={f.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setValues((v) => ({ ...v, [f.key as SearchKey]: e.target.value }))}
            className={`${ui.input} font-mono placeholder:font-sans`}
          />
        </label>
      ))}
      <div className="flex gap-2">
        <button type="submit" className={ui.btnPrimary}>
          Search
        </button>
        <button
          type="button"
          onClick={() => {
            setValues({});
            setError(null);
            onSearch({});
          }}
          className={ui.btnSecondary}
        >
          Clear
        </button>
      </div>
      {error && (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

type Tone = 'ok' | 'warn' | 'bad';
const TONE: Record<Tone, string> = {
  ok: 'bg-positive',
  warn: 'bg-warning',
  bad: 'bg-danger',
};
const TONE_WORD: Record<Tone, string> = { ok: 'OK', warn: 'Attention', bad: 'Failing' };

function Tile({
  label,
  tone,
  value,
  hint,
  loading = false,
}: {
  label: string;
  tone: Tone;
  value: ReactNode;
  hint?: ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-tone={loading ? undefined : tone}
      aria-busy={loading || undefined}
      className="min-w-0 bg-surface px-5 py-4"
    >
      <p className={`flex items-center gap-2 ${ui.statLabel}`}>
        {!loading && (
          <span
            className={`inline-block size-2 rounded-full ${TONE[tone]}`}
            role="img"
            aria-label={TONE_WORD[tone]}
          />
        )}
        {label}
      </p>
      <p className="mt-2.5 text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink tabular-nums">
        {loading ? <Skeleton className="h-6 w-24" /> : value}
      </p>
      {hint && !loading && <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

const TILE_LABELS = [
  'PayPal token',
  'Workflows',
  'Last gate hit',
  'Open top-ups',
  'Pending payouts',
];

function HealthSection({
  health,
  onRefresh,
}: {
  health: Load<AdminHealth>;
  onRefresh: () => void;
}) {
  const header = (
    <div className={`${ui.panelHead} items-center`}>
      <div>
        <h2 className={ui.panelTitle}>Health</h2>
        <p className={ui.panelDesc}>PayPal, Workflows, the gate and money still in flight.</p>
      </div>
      <button type="button" onClick={onRefresh} className={ui.btnSecondary}>
        Refresh
      </button>
    </div>
  );
  // Hairline grid: the 1px gaps show the line colour between tiles at every breakpoint.
  const strip =
    'grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-5 sm:[&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1';

  if (health.status === 'error') {
    return (
      <section aria-label="Health" className={ui.panel}>
        {header}
        <div className={ui.panelBody}>
          <ErrorBanner
            error={health.error}
            title="Health checks didn't load."
            onRetry={onRefresh}
          />
        </div>
      </section>
    );
  }

  if (health.status === 'loading') {
    return (
      <section aria-label="Health" aria-busy="true" className={ui.panel}>
        {header}
        <div className={strip}>
          {TILE_LABELS.map((l) => (
            <Tile key={l} label={l} tone="ok" value={null} loading />
          ))}
        </div>
      </section>
    );
  }

  const h = health.value;
  const failed = failedChecks(h);
  const { paypal, workflows } = h.checks;
  const gate = lastGateHit(h.gate);
  const topups = h.openTopups;
  const payouts = h.pendingPayouts;

  return (
    <section aria-label="Health" className={ui.panel} data-health={h.status}>
      {header}
      {h.status === 'ok' ? (
        <p
          role="status"
          className="border-b border-line bg-positive-tint px-5 py-2.5 text-sm text-positive sm:px-6"
        >
          Healthy. PayPal, the database and Workflows answered. Checked {formatAt(h.checkedAt)}.
        </p>
      ) : (
        <p
          role="alert"
          className="border-b border-line bg-danger-tint px-5 py-2.5 text-sm text-danger sm:px-6"
        >
          Degraded: {failed.length ? failed.join('; ') : 'a dependency check failed'}. Checked{' '}
          {formatAt(h.checkedAt)}.
        </p>
      )}
      <div className={strip}>
        <Tile
          label="PayPal token"
          tone={paypal.ok ? 'ok' : 'bad'}
          value={paypal.ok ? 'Minted' : (paypal.error ?? 'Failed')}
          hint={`${formatCount(paypal.ms)} ms`}
        />
        <Tile
          label="Workflows"
          tone={workflows.ok ? 'ok' : 'bad'}
          value={workflows.mode === 'workflows' ? 'Render Workflows' : 'In-process'}
          hint={
            workflows.missing?.length
              ? `${workflows.detail}: ${workflows.missing.join(', ')}`
              : workflows.detail
          }
        />
        <Tile
          label="Last gate hit"
          tone={!h.gate ? 'bad' : gate ? 'ok' : 'warn'}
          value={!h.gate ? 'Unknown' : gate ? formatAt(gate.at) : 'None yet'}
          hint={
            !h.gate
              ? undefined
              : gate
                ? `${gate.origin} · ${formatCount(gate.sites)} site${gate.sites === 1 ? '' : 's'}`
                : `${formatCount(h.gate.length)} site${h.gate.length === 1 ? '' : 's'}, no gate traffic`
          }
        />
        <Tile
          label="Open top-ups"
          tone={!topups ? 'bad' : topups.needsReconcile > 0 ? 'warn' : 'ok'}
          value={topups ? formatCount(topups.count) : 'Unknown'}
          hint={
            topups
              ? [
                  topups.needsReconcile
                    ? `${formatCount(topups.needsReconcile)} need reconcile`
                    : null,
                  topups.oldestAt
                    ? `oldest ${formatAt(topups.oldestAt)}`
                    : 'none waiting on PayPal',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        />
        <Tile
          label="Pending payouts"
          tone={
            !payouts
              ? 'bad'
              : payouts.batchesNeedingReconcile > 0 || payouts.unclaimedItems > 0
                ? 'warn'
                : 'ok'
          }
          value={payouts ? formatCount(payouts.pendingItems + payouts.unclaimedItems) : 'Unknown'}
          hint={
            payouts
              ? [
                  `${formatCount(payouts.pendingItems)} sent`,
                  `${formatCount(payouts.unclaimedItems)} unclaimed`,
                  payouts.batchesNeedingReconcile
                    ? `${formatCount(payouts.batchesNeedingReconcile)} batch needs reconcile`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
        />
      </div>
    </section>
  );
}

/** "Ledger check" (features/07 §Ledger check): recomputes every balance; the sum must be 0. */
function LedgerCheck({ client }: { client: ApiClient }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LedgerCheckResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client.post<LedgerCheckResult>('/admin/ledger/check'));
    } catch (err) {
      setResult(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const balanced = result !== null && result.sumMicros === 0 && result.mismatches.length === 0;

  return (
    <div className={ui.panel}>
      <div className={`${ui.panelHead} items-center`}>
        <div className="min-w-0 flex-1">
          <h2 className={ui.panelTitle}>Ledger check</h2>
          <p className={ui.panelDesc}>
            Recomputes every account from its entries. Double entry means the sum is 0.
          </p>
        </div>
        <button type="button" onClick={run} disabled={busy} className={ui.btnPrimary}>
          {busy ? 'Checking…' : 'Ledger check'}
        </button>
      </div>
      {(error !== null || result) && (
        <div className={`${ui.panelBody} space-y-3`}>
          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(error)}
            </p>
          )}
          {result && (
            <div
              role={balanced ? 'status' : 'alert'}
              data-ledger={balanced ? 'balanced' : 'mismatch'}
              className={balanced ? ui.notice.positive : ui.notice.danger}
            >
              <p className="font-medium">
                Sum = <span data-sum-micros="">{formatCount(result.sumMicros)}</span> micros (
                <Money micros={result.sumMicros} />) across {formatCount(result.accountsChecked)}{' '}
                account{result.accountsChecked === 1 ? '' : 's'}.{' '}
                {balanced
                  ? 'The ledger balances.'
                  : `${formatCount(result.mismatches.length)} mismatch${result.mismatches.length === 1 ? '' : 'es'}.`}
              </p>
              {!balanced && result.mismatches.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5">
                  {result.mismatches.map((m, i) => (
                    <li key={i}>
                      {m.check}
                      {typeof m.accountId === 'string' ? ` ${m.accountId}` : ''}: expected{' '}
                      {formatCount(m.expectedMicros)}, found {formatCount(m.actualMicros)} micros
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Run payout now" (api.md §Ops; SP-021's `POST /admin/payouts/run`): a labelled demo control at
 * the $1 demo threshold, for every publisher. Two steps (Run → Confirm), and the confirm disables
 * on the first click, so a double click sends one request; the server's period lock would build
 * one batch anyway.
 */
function RunPayout({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminRunResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const keyRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await client.post<AdminRunResult>(
        '/admin/payouts/run',
        { trigger: 'MANUAL_DEMO' },
        { idempotencyKey: keyRef.current ?? crypto.randomUUID() },
      );
      setResult(r);
      setConfirming(false);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const failed = result?.outcome === 'FAILED' || result?.outcome === 'NEEDS_RECONCILE';

  return (
    <div className={ui.panel}>
      <div className={`${ui.panelHead} items-center`}>
        <div className="min-w-0 flex-1">
          <h2 className={`${ui.panelTitle} flex flex-wrap items-center gap-2`}>
            Run payout now
            <span
              className={`rounded-sm bg-warning-tint px-1.5 py-0.5 text-warning ${ui.caption} text-[10px]`}
            >
              Demo control
            </span>
          </h2>
          <p className={ui.panelDesc}>
            Pays every publisher over the $1 demo threshold via PayPal Payouts.
          </p>
        </div>
        {!confirming && (
          <button
            type="button"
            onClick={() => {
              keyRef.current = crypto.randomUUID(); // one key per confirm
              setResult(null);
              setError(null);
              setConfirming(true);
            }}
            className={ui.btnPrimary}
          >
            Run payout now
          </button>
        )}
      </div>
      {(confirming || error !== null || result) && (
        <div className={`${ui.panelBody} space-y-3`}>
          {confirming && (
            <div className={`flex flex-wrap items-center gap-2 ${ui.notice.warning}`}>
              <span className="flex-1">
                This sends a PayPal sandbox payout batch now. Continue?
              </span>
              <button type="button" onClick={confirm} disabled={busy} className={ui.btnPrimary}>
                {busy ? 'Sending…' : 'Pay out via PayPal'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className={ui.btnSecondary}
              >
                Cancel
              </button>
            </div>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(error)}
            </p>
          )}
          {result && (
            <div
              role={failed ? 'alert' : 'status'}
              data-outcome={result.outcome}
              className={failed ? ui.notice.danger : ui.notice.info}
            >
              <p>{runOutcomeLine(result)}</p>
              {result.paypalBatchId && (
                <p className="mt-1">
                  Batch <PayPalId id={result.paypalBatchId} label="PayPal payout batch id" />
                </p>
              )}
              {result.items.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {result.items.map((i) => (
                    <li key={i.id}>
                      <code className="font-mono text-xs">{i.publisherId.slice(0, 8)}…</code>{' '}
                      <Money cents={i.netCents} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1120px] space-y-6" data-screen="W14">
      <header>
        <h1 className={ui.pageTitle}>
          Admin / <span className={ui.accentWord}>audit</span>
        </h1>
        <p className={ui.pageLede}>
          Find any money event by its PayPal id and prove the ledger balances.
        </p>
      </header>
      {children}
    </div>
  );
}

export default function AuditPage() {
  return <AuditScreen />;
}
