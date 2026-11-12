import { formatCents, formatMicros } from '@spigot/shared/money';
import { MONEY_WORDS } from '@spigot/shared/copy';
import type { PillTone } from '../../components';

/**
 * W12 shapes and copy (screens.md §W12; features/10). Shapes mirror the API:
 * - `GET /api/buyer/usage` / `GET /api/buyer/calls/:id` (SP-030a, `reports/usage.ts`);
 * - `GET|POST /api/buyer/claims` (SP-050, `routes/buyer-claims.ts`);
 * - `GET|POST /api/buyer/refunds` (SP-049, `routes/buyer-refunds.ts`).
 * Money words follow the copy rule: "credited" for a claim (no PayPal call), "refunded to PayPal"
 * only once the PayPal Refund completed.
 */

export interface UsageRow {
  id: string;
  time: string;
  dataset: { id: string; site: string; slug: string } | null;
  endpoint: string | null;
  channel: 'REST' | 'MCP';
  status: string;
  records: number | null;
  changes: number | null;
  chargedMicros: number;
  creditedMicros: number;
  replayable: boolean;
  isSimulated: boolean;
}

export interface UsagePage {
  rows: UsageRow[];
  nextCursor: string | null;
}

export interface CallDetail extends UsageRow {
  unitPriceMicros: number | null;
  httpStatus: number | null;
  idempotencyKey: string;
  servedRecords: { key: string; hash: string }[];
}

export const CLAIM_REASONS = [
  'STALE',
  'WRONG_VALUE',
  'MISSING_FIELD',
  'DUPLICATE',
  'REMOVED',
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

export const REASON_LABEL: Record<ClaimReason, string> = {
  STALE: 'Out of date (the site has changed)',
  WRONG_VALUE: 'A value is wrong',
  MISSING_FIELD: 'A field is missing',
  DUPLICATE: 'Duplicate of another record',
  REMOVED: 'No longer on the site',
};

export const REASON_SHORT: Record<ClaimReason, string> = {
  STALE: 'Out of date',
  WRONG_VALUE: 'Wrong value',
  MISSING_FIELD: 'Missing field',
  DUPLICATE: 'Duplicate',
  REMOVED: 'Removed',
};

export type ClaimStatus = 'OPEN' | 'AUTO_CREDITED' | 'CREDITED' | 'REJECTED';

export interface BuyerClaim {
  id: string;
  status: ClaimStatus;
  reason: ClaimReason;
  note: string | null;
  callId: string;
  site: string;
  dataset: string;
  recordKey: string;
  amountMicros: number;
  creditMicros: number;
  decidedBy: 'AUTO' | 'PUBLISHER' | 'ADMIN' | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimResult {
  claimId: string;
  status: ClaimStatus;
  creditMicros: number;
}

export const CLAIM_STATUS: Record<ClaimStatus, { label: string; tone: PillTone }> = {
  AUTO_CREDITED: { label: 'Credited automatically', tone: 'positive' },
  CREDITED: { label: 'Credited by the publisher', tone: 'positive' },
  OPEN: { label: 'Waiting for the publisher', tone: 'info' },
  REJECTED: { label: 'Rejected by the publisher', tone: 'neutral' },
};

/** "$0.0015 credited" / "Up to $0.0015 if the publisher agrees" / "Not credited". */
export function claimMoneyLine(c: Pick<BuyerClaim, 'status' | 'creditMicros' | 'amountMicros'>) {
  if (c.status === 'AUTO_CREDITED' || c.status === 'CREDITED') {
    return `${formatMicros(c.creditMicros)} ${MONEY_WORDS.credited}`;
  }
  if (c.status === 'OPEN') return `Up to ${formatMicros(c.amountMicros)} if the publisher agrees`;
  return 'Not credited';
}

/** What the drawer says right after a claim is filed. */
export function claimResultMessage(r: ClaimResult, amountMicros: number | null): string {
  if (r.status === 'AUTO_CREDITED' || r.status === 'CREDITED') {
    return `Confirmed. ${formatMicros(r.creditMicros)} ${MONEY_WORDS.credited} to your balance.`;
  }
  if (r.status === 'REJECTED') return 'The publisher already rejected this claim.';
  const upTo = amountMicros ? ` We'll credit ${formatMicros(amountMicros)} if they agree.` : '';
  return `We couldn't confirm it automatically, so it's with the publisher.${upTo}`;
}

/** Claims are accepted for 7 days after the call (features/10 §Claims 1). */
export const CLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIMABLE = new Set(['CHARGED', 'PARTIALLY_CREDITED', 'CREDITED']);

/** Why a call can't be claimed on, or `null` when it can. */
export function notClaimableReason(call: CallDetail, now: number): string | null {
  if (!CLAIMABLE.has(call.status))
    return 'This call was not charged, so there is nothing to claim.';
  if (now - Date.parse(call.time) > CLAIM_WINDOW_MS) {
    return 'Claims can be made within 7 days of the call.';
  }
  if (call.servedRecords.length === 0) return 'This call has no records to report.';
  return null;
}

// ------------------------------------------------------------------------------------- refunds

export type RefundStatus = 'REQUESTED' | 'PENDING' | 'COMPLETED' | 'FAILED';

export interface RefundView {
  refundId: string;
  topupId: string;
  amountCents: number;
  status: RefundStatus;
  paypalRefundId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundsResponse {
  refunds: RefundView[];
  available: { balanceCents: number; refundableCents: number; allowedCents: number };
}

export interface RefundPostResponse {
  refunds: RefundView[];
  totalCents: number;
  balanceMicros: number;
  autoTopupDisabled: boolean;
  replay?: boolean;
}

export const REFUND_STATUS: Record<RefundStatus, { label: string; tone: PillTone }> = {
  REQUESTED: { label: 'Refund requested', tone: 'info' },
  PENDING: { label: 'Pending at PayPal', tone: 'info' },
  COMPLETED: { label: 'Refunded to PayPal', tone: 'positive' },
  FAILED: { label: "PayPal couldn't refund", tone: 'danger' },
};

export const isRefundInFlight = (r: RefundView) =>
  r.status === 'REQUESTED' || r.status === 'PENDING';

/** One line per refund, worded by the money copy rule. */
export function refundLine(r: RefundView): string {
  const amount = formatCents(r.amountCents);
  switch (r.status) {
    case 'COMPLETED':
      return `${amount} ${MONEY_WORDS.refundedToPayPal}`;
    case 'FAILED':
      return `${amount} not refunded: PayPal declined the refund${r.errorCode ? ` (${r.errorCode})` : ''}. It is back in your balance.`;
    default:
      return `${amount} refund requested; waiting for PayPal`;
  }
}

/**
 * Why the refundable amount is below the balance (features/10 edge cases: "Capped; message
 * explains"), or `null` when the whole balance can go back.
 */
export function refundCapNote(a: RefundsResponse['available']): string | null {
  if (a.allowedCents >= a.balanceCents) return null;
  if (a.refundableCents === 0) {
    return 'None of your balance can go back to PayPal: it came from credits, or from top-ups more than 180 days old.';
  }
  return `Only ${formatCents(a.allowedCents)} of your ${formatCents(a.balanceCents)} balance can go back to PayPal. The rest came from credits or top-ups more than 180 days old, or is already being refunded.`;
}

export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
