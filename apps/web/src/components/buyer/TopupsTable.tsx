import type { TopupStatus } from '@spigot/shared/copy';
import { Money } from '../Money';
import { PayPalId } from '../PayPalId';
import { StatusPill } from '../StatusPill';

/** `GET /api/buyer/topups` row (SP-018a `topupView`). */
export interface TopupRowView {
  topupId: string;
  amountCents: number;
  currency: string;
  method: 'PAYPAL_WALLET' | 'CARD' | 'VAULT_MIT' | null;
  trigger: 'MANUAL' | 'AUTO' | 'MCP' | 'SIM';
  status: TopupStatus;
  orderId: string | null;
  captureId: string | null;
  errorCode: string | null;
  pendingReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const METHOD_LABEL: Record<NonNullable<TopupRowView['method']>, string> = {
  PAYPAL_WALLET: 'PayPal',
  CARD: 'Card via PayPal',
  VAULT_MIT: 'Saved method via PayPal',
};

/**
 * Top-ups (W11): amount, method, trigger (MANUAL / AUTO / MCP / SIM), PayPal order + capture id,
 * status. SIM rows are seeded sandbox top-ups (SP-035); the trigger column says so.
 */
export function TopupsTable({ topups }: { topups: TopupRowView[] }) {
  return (
    <section
      aria-labelledby="topups-title"
      className="rounded-lg border border-line bg-surface p-5 shadow-card"
    >
      <h2 id="topups-title" className="text-lg font-semibold text-ink">
        Top-ups
      </h2>
      {topups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No top-ups yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 text-right font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Method</th>
                <th className="py-2 pr-4 font-medium">Trigger</th>
                <th className="py-2 pr-4 font-medium">PayPal order</th>
                <th className="py-2 pr-4 font-medium">PayPal capture</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {topups.map((t) => (
                <tr key={t.topupId} className="border-t border-line" data-topup={t.topupId}>
                  <td className="whitespace-nowrap py-2 pr-4 text-body">
                    {new Date(t.createdAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="py-2 pr-4 text-right text-ink">
                    <Money cents={t.amountCents} />
                  </td>
                  <td className="py-2 pr-4 text-body">{t.method ? METHOD_LABEL[t.method] : '—'}</td>
                  <td className="py-2 pr-4">
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-body">
                      {t.trigger}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <PayPalId id={t.orderId} label="PayPal order id" />
                  </td>
                  <td className="py-2 pr-4">
                    <PayPalId id={t.captureId} label="PayPal capture id" />
                  </td>
                  <td className="py-2">
                    <StatusPill kind="topup" status={t.status} />
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
