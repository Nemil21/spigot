import {
  CLAIM_STATUS,
  REASON_SHORT,
  claimMoneyLine,
  formatWhen,
  type BuyerClaim,
} from './usageModel';
import { Pill } from './Pill';

/**
 * The buyer's claims (W12): when, record, reason, status and what was credited. States follow
 * features/10: credited automatically (a deterministic check confirmed it), waiting for the
 * publisher (OPEN), credited or rejected by the publisher. "Credited" money goes back to the
 * Spigot balance; no PayPal call.
 */
export function ClaimsList({
  claims,
  onOpenCall,
}: {
  claims: BuyerClaim[];
  onOpenCall: (callId: string) => void;
}) {
  return (
    <section
      aria-labelledby="claims-title"
      className="rounded-lg border border-line bg-surface p-5 shadow-card"
    >
      <h2 id="claims-title" className="text-lg font-semibold text-ink">
        Claims
      </h2>
      {claims.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No claims. If a record you paid for is wrong, open the call and report it.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Record</th>
                <th className="py-2 pr-4 font-medium">Reason</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} className="border-t border-line align-top" data-claim={c.id}>
                  <td className="whitespace-nowrap py-2 pr-4 text-body">
                    <button
                      type="button"
                      onClick={() => onOpenCall(c.callId)}
                      className="text-accent hover:underline"
                      aria-label={`Open the call for claim on ${c.recordKey}`}
                    >
                      {formatWhen(c.createdAt)}
                    </button>
                  </td>
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs text-ink">{c.recordKey}</span>
                    {c.note && <p className="mt-0.5 text-xs text-muted">“{c.note}”</p>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-body">
                    {REASON_SHORT[c.reason]}
                  </td>
                  <td className="py-2 pr-4">
                    <Pill tone={CLAIM_STATUS[c.status].tone} status={c.status}>
                      {CLAIM_STATUS[c.status].label}
                    </Pill>
                  </td>
                  <td className="py-2 text-right tabular-nums text-body">{claimMoneyLine(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
