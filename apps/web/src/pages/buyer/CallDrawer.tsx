import { formatCount } from '@spigot/shared/money';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiClient } from '../../api/client';
import { ErrorBanner, Money, SimChip, SkeletonText, errorMessage } from '../../components';
import {
  CLAIM_REASONS,
  CLAIM_STATUS,
  REASON_LABEL,
  claimResultMessage,
  formatWhen,
  notClaimableReason,
  type BuyerClaim,
  type CallDetail,
  type ClaimReason,
  type ClaimResult,
} from './usageModel';
import * as ui from '../../components/buyer/ui';
import { Pill } from './Pill';

export const callPath = (id: string) => `/api/buyer/calls/${encodeURIComponent(id)}`;
export const CLAIMS_PATH = '/api/buyer/claims';

/**
 * Per-call drawer (W12): what the call was, what it cost, and "Report a bad record" for any record
 * it served (features/10 §Claims 1: within 7 days, one claim per record per call). Records that
 * already have a claim show its status instead of being offered again.
 */
export function CallDrawer({
  callId,
  client,
  claims,
  onClaimed,
  onClose,
  now = Date.now,
}: {
  callId: string;
  client: ApiClient;
  /** The buyer's claims; the ones on this call mark their records. */
  claims: BuyerClaim[];
  onClaimed: (r: ClaimResult) => void;
  onClose: () => void;
  now?: () => number;
}) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setCall(null);
    setError(null);
    client.get<CallDetail>(callPath(callId)).then(
      (c) => live && setCall(c),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [client, callId, attempt]);

  const claimed = new Map(claims.filter((c) => c.callId === callId).map((c) => [c.recordKey, c]));

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/40" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-title"
        className="relative flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto border-l border-line bg-surface px-6 pb-8 shadow-[0_0_48px_-12px_rgb(0_0_0/0.35)]"
      >
        <header className="sticky top-0 z-10 -mx-6 flex items-start justify-between gap-4 border-b border-line bg-surface px-6 py-4">
          <div>
            <h2 id="call-title" className="text-base font-semibold text-ink">
              Call
            </h2>
            {call && (
              <p className="mt-0.5 text-sm text-muted tabular-nums">
                {formatWhen(call.time)} · {call.channel}
                {call.isSimulated && (
                  <span className="ml-2">
                    <SimChip />
                  </span>
                )}
              </p>
            )}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className={ui.btnGhost}>
            Close
          </button>
        </header>

        {error !== null ? (
          <ErrorBanner error={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !call ? (
          <div aria-busy="true">
            <SkeletonText lines={5} />
          </div>
        ) : (
          <>
            <dl className="divide-y divide-line text-sm">
              <Line label="Dataset">
                {call.dataset ? `${call.dataset.site} / ${call.dataset.slug}` : '—'}
              </Line>
              <Line label="Endpoint">
                <span className="font-mono text-xs">{call.endpoint ?? '—'}</span>
              </Line>
              <Line label={call.changes !== null && call.records === null ? 'Changes' : 'Records'}>
                <span className="tabular-nums">
                  {formatCount(call.records ?? call.changes ?? 0)}
                </span>
              </Line>
              {call.unitPriceMicros !== null && (
                <Line label="Price per record">
                  <Money micros={call.unitPriceMicros} />
                </Line>
              )}
              <Line label="Charged">
                {call.chargedMicros > 0 ? (
                  <Money micros={call.chargedMicros} word="charged" />
                ) : (
                  <span className="text-muted">Not charged</span>
                )}
              </Line>
              {call.creditedMicros > 0 && (
                <Line label="Credited back">
                  <Money micros={call.creditedMicros} word="credited" />
                </Line>
              )}
              <Line label="Idempotency key">
                <span className="break-all font-mono text-xs">{call.idempotencyKey}</span>
              </Line>
              {call.replayable && (
                <Line label="Replay">
                  <span className="text-body">Retrying with this key returns it again, free</span>
                </Line>
              )}
            </dl>
            <ReportBadRecord
              call={call}
              claimed={claimed}
              client={client}
              now={now}
              onClaimed={onClaimed}
            />
          </>
        )}
      </aside>
    </div>
  );
}

function ReportBadRecord({
  call,
  claimed,
  client,
  now,
  onClaimed,
}: {
  call: CallDetail;
  claimed: Map<string, BuyerClaim>;
  client: ApiClient;
  now: () => number;
  onClaimed: (r: ClaimResult) => void;
}) {
  const open = call.servedRecords.filter((r) => !claimed.has(r.key));
  const [recordKey, setRecordKey] = useState(open[0]?.key ?? '');
  const [reason, setReason] = useState<ClaimReason>('STALE');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

  const blocked = notClaimableReason(call, now());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!recordKey) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const r = await client.post<ClaimResult>(CLAIMS_PATH, {
        callId: call.id,
        recordKey,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setResult(claimResultMessage(r, call.unitPriceMicros));
      setNote('');
      const next = open.find((o) => o.key !== recordKey);
      setRecordKey(next?.key ?? '');
      onClaimed(r);
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-labelledby="report-title" className="space-y-3 border-t border-line pt-6">
      <h3 id="report-title" className="text-sm font-semibold text-ink">
        Report a bad record
      </h3>
      {blocked ? (
        <p className="text-sm text-muted">{blocked}</p>
      ) : (
        <>
          <p className="text-sm text-body">
            If Spigot can confirm the problem, the record's price is credited to your balance at
            once. Otherwise the publisher decides.
          </p>
          {open.length === 0 ? (
            <p className="text-sm text-muted">Every record in this call already has a claim.</p>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <label className={ui.label}>
                <span>Record</span>
                <select
                  value={recordKey}
                  onChange={(e) => setRecordKey(e.target.value)}
                  className={`${ui.input} font-mono text-xs`}
                >
                  {open.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.key}
                    </option>
                  ))}
                </select>
              </label>
              <label className={ui.label}>
                <span>What's wrong</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as ClaimReason)}
                  className={ui.input}
                >
                  {CLAIM_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {REASON_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={ui.label}>
                <span>
                  Note <span className="font-normal text-muted">(optional)</span>
                </span>
                <textarea
                  value={note}
                  maxLength={2000}
                  rows={2}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Listing says leased on the site"
                  className={`${ui.input} h-auto py-2`}
                />
              </label>
              <button type="submit" disabled={sending || !recordKey} className={ui.btnPrimary}>
                {sending ? 'Sending…' : 'Report record'}
              </button>
            </form>
          )}
        </>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(error)}
        </p>
      )}
      {result && (
        <p role="status" className={ui.notice.info}>
          {result}
        </p>
      )}
      {claimed.size > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Claims on this call">
          {[...claimed.values()].map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-ink">{c.recordKey}</span>
              <Pill tone={CLAIM_STATUS[c.status].tone} status={c.status}>
                {CLAIM_STATUS[c.status].label}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
