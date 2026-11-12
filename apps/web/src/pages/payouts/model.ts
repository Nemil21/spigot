import type { PayoutItemStatus } from '@spigot/shared/copy';
import { formatCents, formatCount, formatMicros } from '@spigot/shared/money';

/** `GET /api/publishers/me/payouts` (SP-021 `payouts/view.ts`). */
export interface PayoutItem {
  id: string;
  paypalItemId: string | null;
  status: PayoutItemStatus;
  netCents: number;
  feeCents: number | null;
  grossMicros: number;
  commissionMicros: number;
  receiverEmail: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface PayoutBatch {
  id: string;
  paypalBatchId: string | null;
  status: string;
  trigger: string;
  needsReconcile: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  items: PayoutItem[];
}

export interface NextPayout {
  payableMicros: number;
  payableCents: number;
  thresholdCents: number;
  nextPayoutDate: string;
  inFlightCents: number;
  eligible: boolean;
}

export interface PublisherPayouts {
  isDemo: boolean;
  next: NextPayout;
  batches: PayoutBatch[];
}

/** `GET /api/publishers/me/payouts/statements` (SP-031 `payouts/statements.ts`). */
export interface Statement {
  periodStart: string | null;
  periodEnd: string;
  recordsSold: number;
  grossMicros: number;
  commissionMicros: number;
  simGrossMicros: number;
  simRecords: number;
  roundingCarriedMicros: number | null;
}

export interface PayoutStatements {
  next: Statement;
  items: Record<string, Statement>;
}

/** `POST /api/publishers/me/payouts/run` (SP-021, demo control). */
export interface RunResult {
  demoControl: true;
  outcome: 'PENDING' | 'NO_ITEMS' | 'PERIOD_TAKEN' | 'NEEDS_RECONCILE' | 'FAILED' | 'RETRY_LATER';
  batchId: string | null;
  paypalBatchId?: string;
  errorCode?: string;
  items: { id: string; netCents: number }[];
}

/** The demo run's threshold (SP-021 `DEMO_THRESHOLD_CENTS`): $1, labelled as a demo control. */
export const DEMO_THRESHOLD_CENTS = 100;

/**
 * SP-020's alert for `422 INSUFFICIENT_FUNDS` (apps/api/src/payouts/submit.ts
 * `INSUFFICIENT_FUNDS_ALERT`). Keep the two in step.
 */
export const INSUFFICIENT_FUNDS_ALERT = 'Fund the sandbox merchant or lower the demo threshold';

/** Why PayPal didn't pay an item, in words (the code stays visible next to it). */
export function failureReason(code: string | null): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return `PayPal refused the batch: the sandbox merchant balance is too low. ${INSUFFICIENT_FUNDS_ALERT}.`;
    case 'SELF_PAY_NOT_ALLOWED':
      return 'PayPal won’t pay the platform’s own account. Use a separate payout email in Settings.';
    case 'RECEIVER_UNREGISTERED':
    case 'RETURNED':
      return 'Nobody claimed it within 30 days, so PayPal returned it.';
    case null:
    case '':
      return 'PayPal didn’t pay this item.';
    default:
      return `PayPal didn’t pay this item (${code}).`;
  }
}

/** "Nov 4–11, 2026" from ISO bounds (UTC, like the PayPal item note). */
export function formatPeriod(start: string | null, end: string | null): string {
  if (!end) return '—';
  const e = new Date(end);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  if (!start) return fmt(e, true);
  const s = new Date(start);
  if (s.toISOString().slice(0, 10) === e.toISOString().slice(0, 10)) return fmt(e, true);
  return `${fmt(s, s.getUTCFullYear() !== e.getUTCFullYear())} – ${fmt(e, true)}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "incl. $1.20 / 12 records simulated", or null when the period has no SIM charges. */
export function simShareLine(s: Pick<Statement, 'simGrossMicros' | 'simRecords'>): string | null {
  if (s.simGrossMicros === 0 && s.simRecords === 0) return null;
  const records = `${formatCount(s.simRecords)} ${s.simRecords === 1 ? 'record' : 'records'}`;
  return `incl. ${formatMicros(s.simGrossMicros)} / ${records} simulated`;
}

/** The SIM chip's tooltip on a payout row (features/15). */
export function simChipTooltip(s: Pick<Statement, 'simGrossMicros' | 'simRecords'>): string {
  return (
    `This period's earnings ${simShareLine(s) ?? 'include simulated charges'}. ` +
    'The payout itself is real money sent via PayPal to the sandbox account.'
  );
}

/** "Next PayPal payout Monday · $412.75 payable · threshold $10". */
export function nextPayoutLine(n: Pick<NextPayout, 'payableCents' | 'thresholdCents'>): string {
  return (
    `Next PayPal payout Monday · ${formatCents(n.payableCents)} payable · ` +
    `threshold ${formatCents(n.thresholdCents)}`
  );
}

/** The batch row amount: the caller's items only (the API never sends anyone else's). */
export function batchAmountCents(b: PayoutBatch): number {
  return b.items.reduce((s, i) => s + i.netCents, 0);
}

/** The status the batch row shows: the caller's item (one per batch), worst first if several. */
export function batchItemStatus(b: PayoutBatch): PayoutItemStatus | null {
  const order: PayoutItemStatus[] = ['FAILED', 'RETURNED', 'UNCLAIMED', 'PENDING', 'SUCCESS'];
  for (const s of order) if (b.items.some((i) => i.status === s)) return s;
  return null;
}
