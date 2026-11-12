import {
  CLAIM_STATUS,
  REASON_SHORT,
  claimMoneyLine,
  formatWhen,
  type BuyerClaim,
} from './usageModel';
import * as ui from '../../components/buyer/ui';
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
    <section aria-labelledby="claims-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="claims-title" className={ui.panelTitle}>
            Claims
          </h2>
          <p className={ui.panelDesc}>
            Records you reported as wrong. Credits go back to your Spigot balance.
          </p>
        </div>
      </div>
      {claims.length === 0 ? (
        <p className={`${ui.panelBody} text-sm text-muted`}>
          No claims. If a record you paid for is wrong, open the call and report it.
        </p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>When</th>
                <th className={ui.th}>Record</th>
                <th className={ui.th}>Reason</th>
                <th className={ui.th}>Status</th>
                <th className={`${ui.th} text-right`}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} className={`${ui.tr} align-top`} data-claim={c.id}>
                  <td className={`${ui.td} whitespace-nowrap`}>
                    <button
                      type="button"
                      onClick={() => onOpenCall(c.callId)}
                      className="font-medium text-accent tabular-nums underline-offset-2 hover:underline"
                      aria-label={`Open the call for claim on ${c.recordKey}`}
                    >
                      {formatWhen(c.createdAt)}
                    </button>
                  </td>
                  <td className={`${ui.td} min-w-48`}>
                    <span className="break-all font-mono text-xs text-ink">{c.recordKey}</span>
                    {c.note && <p className="mt-1 text-xs text-muted">“{c.note}”</p>}
                  </td>
                  <td className={`${ui.td} whitespace-nowrap text-body`}>
                    {REASON_SHORT[c.reason]}
                  </td>
                  <td className={ui.td}>
                    <Pill tone={CLAIM_STATUS[c.status].tone} status={c.status}>
                      {CLAIM_STATUS[c.status].label}
                    </Pill>
                  </td>
                  <td className={`${ui.td} text-right tabular-nums text-body`}>
                    {claimMoneyLine(c)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
