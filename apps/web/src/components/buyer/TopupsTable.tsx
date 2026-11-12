import type { TopupStatus } from '@spigot/shared/copy';
import { Money } from '../Money';
import { PayPalId } from '../PayPalId';
import { StatusPill } from '../StatusPill';
import * as ui from './ui';

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
    <section aria-labelledby="topups-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="topups-title" className={ui.panelTitle}>
            Top-ups
          </h2>
          <p className={ui.panelDesc}>Every payment into your balance, with its PayPal ids.</p>
        </div>
      </div>
      {topups.length === 0 ? (
        <p className={`${ui.panelBody} text-sm text-muted`}>No top-ups yet.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>When</th>
                <th className={`${ui.th} text-right`}>Amount</th>
                <th className={ui.th}>Method</th>
                <th className={ui.th}>Trigger</th>
                <th className={ui.th}>PayPal order</th>
                <th className={ui.th}>PayPal capture</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {topups.map((t) => (
                <tr key={t.topupId} className={ui.tr} data-topup={t.topupId}>
                  <td className={`${ui.td} whitespace-nowrap text-body tabular-nums`}>
                    {new Date(t.createdAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className={`${ui.td} text-right font-medium text-ink`}>
                    <Money cents={t.amountCents} />
                  </td>
                  <td className={`${ui.td} whitespace-nowrap text-body`}>
                    {t.method ? METHOD_LABEL[t.method] : '—'}
                  </td>
                  <td className={ui.td}>
                    <span className={ui.tag}>{t.trigger}</span>
                  </td>
                  <td className={ui.td}>
                    <PayPalId id={t.orderId} label="PayPal order id" />
                  </td>
                  <td className={ui.td}>
                    <PayPalId id={t.captureId} label="PayPal capture id" />
                  </td>
                  <td className={ui.td}>
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
