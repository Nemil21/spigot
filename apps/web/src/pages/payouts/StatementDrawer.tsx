import { payoutLine } from '@spigot/shared/copy';
import { formatCount } from '@spigot/shared/money';
import { useEffect, useRef, type ReactNode } from 'react';
import { Money, PayPalId, SkeletonText, StatusPill } from '../../components';
import {
  formatPeriod,
  simShareLine,
  type PayoutBatch,
  type PayoutItem,
  type Statement,
} from './model';

/**
 * W09 statement drawer (screens.md §W09): period, records sold, gross, commission, net, rounding
 * carried forward, and the SIM share of gross and records (features/15). The net is what PayPal
 * was asked to send; its line follows the money copy rule (`payoutLine`).
 */
export function StatementDrawer({
  batch,
  item,
  statement,
  onClose,
}: {
  batch: PayoutBatch;
  item: PayoutItem;
  /** Undefined while the statements are still loading. */
  statement: Statement | undefined;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sim = statement ? simShareLine(statement) : null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/30" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="statement-title"
        className="relative flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto border-l border-line bg-surface p-6 shadow-card"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="statement-title" className="text-lg font-semibold text-ink">
              Statement
            </h2>
            <p className="mt-1 text-sm text-muted">
              {formatPeriod(statement?.periodStart ?? batch.periodStart, batch.periodEnd)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-ink"
          >
            Close
          </button>
        </header>

        <p className="flex flex-wrap items-center gap-2 text-sm text-body">
          <StatusPill kind="payout" status={item.status} />
          <span>{payoutLine(item.status, item.netCents)}</span>
        </p>

        {statement ? (
          <dl className="divide-y divide-line text-sm" data-statement="">
            <Line label="Records sold">
              <span className="tabular-nums">{formatCount(statement.recordsSold)}</span>
            </Line>
            <Line label="Gross (what buyers were charged)">
              <Money micros={statement.grossMicros} />
            </Line>
            <Line label="Spigot commission">
              <span>
                −<Money micros={statement.commissionMicros} />
              </span>
            </Line>
            <Line label="Net payout via PayPal" strong>
              <Money cents={item.netCents} />
            </Line>
            <Line label="Rounding carried forward">
              {statement.roundingCarriedMicros === null ? (
                <span className="text-muted">—</span>
              ) : (
                <Money micros={statement.roundingCarriedMicros} />
              )}
            </Line>
          </dl>
        ) : (
          <div aria-busy="true">
            <SkeletonText lines={5} />
          </div>
        )}

        {sim && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-body" data-sim-share="">
            Gross {sim}. The payout itself is real money sent via PayPal to the sandbox account.
          </p>
        )}

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted">PayPal batch id</dt>
            <dd>
              <PayPalId id={batch.paypalBatchId} label="PayPal payout batch id" />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted">PayPal item id</dt>
            <dd>
              <PayPalId id={item.paypalItemId} label="PayPal payout item id" />
            </dd>
          </div>
          {item.feeCents !== null && (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted">PayPal fee (paid by Spigot)</dt>
              <dd>
                <Money cents={item.feeCents} />
              </dd>
            </div>
          )}
        </dl>
        <p className="text-xs text-muted">
          The sub-cent remainder stays in your payable balance and goes out with the next payout.
        </p>
      </aside>
    </div>
  );
}

function Line({
  label,
  strong = false,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-2 ${strong ? 'font-semibold text-ink' : ''}`}
    >
      <dt className={strong ? '' : 'text-muted'}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
