import { formatMicros } from '@spigot/shared/money';
import { MONEY_WORDS } from '@spigot/shared/copy';
import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { ErrorBanner, Money, Skeleton, errorMessage } from '../components';
import { Pill } from './buyer/Pill';
import {
  CLAIM_STATUS,
  REASON_SHORT,
  formatWhen,
  type ClaimReason,
  type ClaimStatus,
} from './buyer/usageModel';

/**
 * W08 claims tab (screens.md §W08 claims tab; features/10 §Claims 3; SP-050). Open claims against
 * the publisher's data, each with the claims triage agent's recommendation (SP-048b), and a
 * one-click Credit / Reject. Crediting gives the buyer back the record's price on that call and
 * takes it off "Payable now"; rejecting closes the claim. The AI only recommends: the decision is
 * the publisher's click.
 *
 * API (SP-048b): `GET /api/claims?status=OPEN` → `{ claims }`; `POST /api/claims/:id/decide`
 * `{ decision }` → `{ claimId, status, creditMicros, replay }` (409 `STATE_CONFLICT` when the
 * claim was already decided the other way).
 */

export const OPEN_CLAIMS_PATH = '/api/claims?status=OPEN';
export const decidePath = (id: string) => `/api/claims/${encodeURIComponent(id)}/decide`;

export type AiRecommendation =
  | {
      status: 'READY';
      decision: 'CREDIT' | 'REJECT';
      confidence: number;
      reason: string;
    }
  | { status: 'UNAVAILABLE' | 'INVALID'; attempts?: number | null };

export interface PublisherClaim {
  id: string;
  status: ClaimStatus;
  reason: ClaimReason;
  note: string | null;
  site: { id: string; slug: string };
  dataset: { id: string; slug: string };
  recordKey: string;
  callId: string;
  /** What a CREDIT gives back (the record's price on that call). */
  amountMicros: number;
  creditMicros: number | null;
  decidedBy: string | null;
  aiRecommendation: AiRecommendation | null;
  createdAt: string;
  updatedAt: string;
}

interface DecideResult {
  claimId: string;
  status: ClaimStatus;
  creditMicros: number;
  replay?: boolean;
}

type Decision = 'CREDIT' | 'REJECT';

export function ClaimsTab({
  client,
  onDecided,
}: {
  client: ApiClient;
  /** A credit moved money: W08 refreshes its KPIs and ledger. */
  onDecided?: () => void;
}) {
  const [claims, setClaims] = useState<PublisherClaim[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
  const [decided, setDecided] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await client.get<{ claims: PublisherClaim[] }>(OPEN_CLAIMS_PATH);
      setClaims(r.claims);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(c: PublisherClaim, decision: Decision) {
    setBusy(c.id);
    setRowError(null);
    setDecided(null);
    try {
      const r = await client.post<DecideResult>(decidePath(c.id), { decision });
      setDecided(
        r.status === 'CREDITED'
          ? `${formatMicros(r.creditMicros)} ${MONEY_WORDS.credited} to the buyer for ${c.recordKey}.`
          : `Claim on ${c.recordKey} rejected.`,
      );
      setClaims((list) => (list ?? []).filter((x) => x.id !== c.id));
      onDecided?.();
    } catch (err) {
      setRowError({ id: c.id, error: err });
      // Decided elsewhere (another tab, or the claim moved on): re-read the list.
      void load();
    } finally {
      setBusy(null);
    }
  }

  if (claims === null && error !== null) {
    return <ErrorBanner error={error} title="Claims didn't load." onRetry={() => void load()} />;
  }
  if (claims === null) return <Skeleton className="block h-48 w-full" />;

  return (
    <section aria-label="Open claims" className="space-y-3" data-tab="claims">
      <p className="text-sm text-body">
        Buyers report records they think are wrong. Spigot credits the clear cases automatically;
        these need you. Crediting gives the buyer back that record's price and comes off your
        payable balance.
      </p>
      {decided && (
        <p role="status" className="rounded-lg bg-info-tint px-4 py-3 text-sm text-info">
          {decided}
        </p>
      )}
      {claims.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-body">
          No open claims. Nothing needs your decision.
        </div>
      ) : (
        <ul className="space-y-3">
          {claims.map((c) => (
            <li
              key={c.id}
              data-claim={c.id}
              className="rounded-lg border border-line bg-surface p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-ink">{c.recordKey}</span>
                    <Pill tone={CLAIM_STATUS[c.status].tone} status={c.status}>
                      {REASON_SHORT[c.reason]}
                    </Pill>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {c.site.slug} · {formatWhen(c.createdAt)} · credit would be{' '}
                    <Money micros={c.amountMicros} />
                  </p>
                  {c.note && (
                    <p className="mt-2 text-sm text-body">
                      <span className="text-muted">Buyer says: </span>“{c.note}”
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void decide(c, 'CREDIT')}
                    aria-label={`Credit ${c.recordKey}`}
                    className="h-8 rounded-md bg-accent px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-60"
                  >
                    {busy === c.id ? 'Saving…' : 'Credit'}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void decide(c, 'REJECT')}
                    aria-label={`Reject ${c.recordKey}`}
                    className="h-8 rounded-md border border-border bg-surface px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink transition-colors hover:bg-surface-2 disabled:opacity-60"
                  >
                    Reject
                  </button>
                </div>
              </div>
              <Recommendation ai={c.aiRecommendation} />
              {rowError?.id === c.id && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {errorMessage(rowError.error)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Recommendation({ ai }: { ai: AiRecommendation | null }) {
  if (!ai) {
    return (
      <p className="mt-3 text-sm text-muted" data-ai="pending">
        Claude is still reading this claim.
      </p>
    );
  }
  if (ai.status !== 'READY') {
    return (
      <p className="mt-3 text-sm text-muted" data-ai="unavailable">
        No AI recommendation for this one. Check the record and decide.
      </p>
    );
  }
  return (
    <div
      className="mt-4 rounded-lg border border-line bg-canvas px-4 py-3 text-sm"
      data-ai="ready"
      data-ai-decision={ai.decision}
    >
      <p className="font-medium text-ink">
        Claude recommends: {ai.decision === 'CREDIT' ? 'Credit' : 'Reject'}{' '}
        <span className="font-normal text-muted">
          ({Math.round(ai.confidence * 100)}% confident)
        </span>
      </p>
      <p className="mt-1 text-body">{ai.reason}</p>
    </div>
  );
}
