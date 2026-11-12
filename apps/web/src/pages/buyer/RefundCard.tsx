import { formatCents } from '@spigot/shared/money';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/client';
import { ErrorBanner, PayPalId, SkeletonText, errorMessage } from '../../components';
import {
  REFUND_STATUS,
  formatWhen,
  isRefundInFlight,
  refundCapNote,
  refundLine,
  type RefundPostResponse,
  type RefundsResponse,
} from './usageModel';
import * as ui from '../../components/buyer/ui';
import { Pill } from './Pill';

export const REFUNDS_PATH = '/api/buyer/refunds';
/** How often to re-read refunds while one is REQUESTED / PENDING at PayPal. */
export const REFUND_POLL_MS = 5_000;

export interface RefundCardProps {
  client: ApiClient;
  /** The balance changed (a refund went out): the page re-reads usage / balance. */
  onBalanceChanged?: () => void;
  pollMs?: number;
  /** Makes Idempotency-Keys (tests pass a deterministic one). */
  newKey?: () => string;
}

/**
 * "Refund unused balance to PayPal" (W12, P1; features/10 §Refund; SP-049's API). Shows the
 * allowed amount (`min(balance, unrefunded captures ≤ 180 days)`) and why it's lower than the
 * balance when it is. One Idempotency-Key per click, reused when the same request is retried, so
 * a timed-out click never refunds twice. While a refund is in flight the card re-reads every few
 * seconds until PayPal settles it.
 */
export function RefundCard({
  client,
  onBalanceChanged,
  pollMs = REFUND_POLL_MS,
  newKey = () => crypto.randomUUID(),
}: RefundCardProps) {
  const [data, setData] = useState<RefundsResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The key of the request being retried; cleared when it settles (or the amount changes). */
  const pendingKey = useRef<{ key: string; cents: number } | null>(null);
  const settled = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const next = await client.get<RefundsResponse>(REFUNDS_PATH);
      setData(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(err);
      return null;
    }
  }, [client]);

  useEffect(() => {
    void load().then((d) => {
      if (!d) return;
      setAmount((a) =>
        a === '' && d.available.allowedCents > 0 ? centsInput(d.available.allowedCents) : a,
      );
      for (const r of d.refunds) if (!isRefundInFlight(r)) settled.current.add(r.refundId);
    });
  }, [load]);

  const inFlight = data?.refunds.some(isRefundInFlight) ?? false;
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      void load().then((d) => {
        if (!d) return;
        // A refund that settled while we watched (COMPLETED, or FAILED and reversed) moves the balance.
        const newlySettled = d.refunds.filter(
          (r) => !isRefundInFlight(r) && !settled.current.has(r.refundId),
        );
        for (const r of newlySettled) settled.current.add(r.refundId);
        if (newlySettled.length) onBalanceChanged?.();
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [inFlight, load, pollMs, onBalanceChanged]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    const cents = parseCents(amount);
    if (cents === null || cents <= 0) {
      setSubmitError(new Error('Enter an amount in dollars, for example 7.40.'));
      return;
    }
    if (cents > data.available.allowedCents) {
      setSubmitError(
        new Error(`You can refund up to ${formatCents(data.available.allowedCents)} to PayPal.`),
      );
      return;
    }
    if (pendingKey.current?.cents !== cents) pendingKey.current = { key: newKey(), cents };
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const res = await client.post<RefundPostResponse>(
        REFUNDS_PATH,
        { amountCents: cents },
        { idempotencyKey: pendingKey.current.key },
      );
      pendingKey.current = null;
      const done = res.refunds.every((r) => r.status === 'COMPLETED');
      setNotice(
        (done
          ? `${formatCents(res.totalCents)} refunded to PayPal.`
          : `Refund of ${formatCents(res.totalCents)} requested. PayPal usually confirms within a minute.`) +
          (res.autoTopupDisabled ? ' Auto top-up is now off.' : ''),
      );
      for (const r of res.refunds) if (!isRefundInFlight(r)) settled.current.add(r.refundId);
      const next = await load();
      setAmount(
        next && next.available.allowedCents > 0 ? centsInput(next.available.allowedCents) : '',
      );
      onBalanceChanged?.();
    } catch (err) {
      // Definite answers end this request; a retryable one keeps its key for the next click.
      if (!(err instanceof ApiError && err.retryable)) pendingKey.current = null;
      setSubmitError(err);
      if (err instanceof ApiError && err.code === 'REFUND_EXCEEDS_UNUSED') void load();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="refund-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="refund-title" className={ui.panelTitle}>
            Refund unused balance to PayPal
          </h2>
          <p className={ui.panelDesc}>
            Money goes back to the PayPal account you topped up from, through a PayPal refund.
          </p>
        </div>
      </div>
      <div className={ui.panelBody}>
        {!data && loadError !== null ? (
          <div>
            <ErrorBanner error={loadError} onRetry={() => void load()} />
          </div>
        ) : !data ? (
          <div aria-busy="true">
            <SkeletonText lines={2} />
          </div>
        ) : (
          <>
            <p
              className="text-sm font-medium text-ink"
              data-allowed-cents={data.available.allowedCents}
            >
              {data.available.allowedCents > 0
                ? `You can get ${formatCents(data.available.allowedCents)} back to the PayPal account you topped up from.`
                : 'Nothing to refund to PayPal right now.'}
            </p>
            {refundCapNote(data.available) && (
              <p className="mt-1 text-xs text-muted">{refundCapNote(data.available)}</p>
            )}
            {data.available.allowedCents > 0 && (
              <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-muted">
                  <span className="block">Amount (USD)</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setSubmitError(null);
                    }}
                    className={`${ui.input} max-w-32`}
                  />
                </label>
                <button type="submit" disabled={submitting} className={ui.btnPrimary}>
                  {submitting ? 'Requesting refund…' : 'Refund to PayPal'}
                </button>
              </form>
            )}
            {submitError !== null && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {errorMessage(submitError)}
              </p>
            )}
            {notice && (
              <p role="status" className={`mt-3 ${ui.notice.info}`}>
                {notice}
              </p>
            )}
            {data.refunds.length > 0 && (
              <ul
                className="mt-5 divide-y divide-line border-t border-line text-sm"
                aria-label="Refunds"
              >
                {data.refunds.map((r) => (
                  <li
                    key={r.refundId}
                    data-refund={r.refundId}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <span className="font-medium text-ink">{refundLine(r)}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted">{formatWhen(r.createdAt)}</span>
                      {r.paypalRefundId && (
                        <PayPalId id={r.paypalRefundId} label="PayPal refund id" />
                      )}
                      <Pill tone={REFUND_STATUS[r.status].tone} status={r.status}>
                        {REFUND_STATUS[r.status].label}
                      </Pill>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** "7.4" / "$7.40" → 740; anything else → null. */
export function parseCents(input: string): number | null {
  const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const centsInput = (cents: number) => (cents / 100).toFixed(2);
