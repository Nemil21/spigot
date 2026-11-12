import { formatCents } from '@spigot/shared/money';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Money, SkeletonText, errorMessage } from '../../components';
import { DEMO_THRESHOLD_CENTS, simShareLine, type NextPayout, type Statement } from './model';

/**
 * "Run payout now" confirm (screens.md §W09; features/13 §5): payable, commission already taken,
 * net, threshold. A **demo control** for the demo publisher only: it runs SP-021's
 * `POST /api/publishers/me/payouts/run` at the $1 demo threshold. The confirm button disables on
 * the first click, so a double click sends one request (the server's advisory lock and in-flight
 * rule would build one item anyway).
 */
export function RunPayoutModal({
  next,
  statement,
  onConfirm,
  onClose,
}: {
  next: NextPayout;
  /** The next payout's statement preview; undefined while loading. */
  statement: Statement | undefined;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const blocked =
    next.inFlightCents > 0
      ? `${formatCents(next.inFlightCents)} is already on its way via PayPal. The next payout waits until PayPal settles it.`
      : next.payableCents < DEMO_THRESHOLD_CENTS
        ? `Nothing to pay out yet: ${formatCents(next.payableCents)} payable is under the ${formatCents(DEMO_THRESHOLD_CENTS)} demo threshold.`
        : null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const sim = statement ? simShareLine(statement) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink/30"
        aria-hidden="true"
        onClick={() => !busy && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-payout-title"
        className="relative w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-card"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-warning">Demo control</p>
        <h2 id="run-payout-title" className="mt-1 text-lg font-semibold text-ink">
          Run payout now?
        </h2>
        <p className="mt-1 text-sm text-muted">
          Sends your payable balance via PayPal Payouts now instead of Monday. Uses the{' '}
          {formatCents(DEMO_THRESHOLD_CENTS)} demo threshold.
        </p>

        <dl className="mt-4 divide-y divide-line text-sm">
          <Row label="Payable">
            <Money micros={next.payableMicros} />
          </Row>
          <Row label="Commission already taken">
            {statement ? <Money micros={statement.commissionMicros} /> : <SkeletonText lines={1} />}
          </Row>
          <Row label="Net via PayPal" strong>
            <Money cents={next.payableCents} />
          </Row>
          <Row label="Threshold">
            <span>
              {formatCents(DEMO_THRESHOLD_CENTS)} demo{' '}
              <span className="text-muted">(usually {formatCents(next.thresholdCents)})</span>
            </span>
          </Row>
        </dl>
        {sim && <p className="mt-2 text-xs text-muted">Gross {sim}.</p>}

        {blocked && (
          <p role="status" className="mt-4 rounded-md bg-info-tint px-3 py-2 text-sm text-info">
            {blocked}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">
            {errorMessage(error)}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-body hover:bg-surface-2 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || blocked !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
          >
            {busy ? 'Sending via PayPal…' : `Pay out ${formatCents(next.payableCents)} via PayPal`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
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
