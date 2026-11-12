import { formatCents, formatCount, formatMicros } from './money.js';

/**
 * User-facing copy shared by the API (error messages, MCP text) and the web app, so every surface
 * words money the same way. Strings follow screens.md word for word; `copy.test.ts` checks them
 * against the spec file.
 *
 * Money copy rule (screens.md):
 *   - "charged" only after a 2xx response was built and the ledger posted;
 *   - "credited" for a junk-data claim back to the balance (no PayPal call);
 *   - "refunded to PayPal" only after a PayPal Refund completed;
 *   - "sent" when a payout item is PENDING; "paid out" only on SUCCESS; "waiting for you to claim"
 *     for UNCLAIMED;
 *   - name PayPal on every money moment.
 * Importers: SP-017a/017b, SP-022a, SP-024b, SP-031, SP-032, SP-033.
 */

// ---------------------------------------------------------------------------------------------
// Money copy rule

export const MONEY_WORDS = {
  charged: 'charged',
  credited: 'credited',
  refundedToPayPal: 'refunded to PayPal',
  sent: 'sent',
  paidOut: 'paid out',
  waitingToClaim: 'waiting for you to claim',
} as const;

export const TOP_UP_WITH_PAYPAL = 'Top up with PayPal';
export const PAID_OUT_VIA_PAYPAL = 'Paid out via PayPal';

/** "$0.0555 charged". Only for a call whose 2xx was built and whose CHARGE posted. */
export function chargedLine(micros: number): string {
  return `${formatMicros(micros)} ${MONEY_WORDS.charged}`;
}

/** "$0.0555 credited". A claim credited back to the Spigot balance; no PayPal call. */
export function creditedLine(micros: number): string {
  return `${formatMicros(micros)} ${MONEY_WORDS.credited}`;
}

/** "$7.40 refunded to PayPal". Only after the PayPal Refund completed. */
export function refundedToPayPalLine(cents: number): string {
  return `${formatCents(cents)} ${MONEY_WORDS.refundedToPayPal}`;
}

export const PAYOUT_ITEM_STATUSES = [
  'PENDING',
  'SUCCESS',
  'UNCLAIMED',
  'FAILED',
  'RETURNED',
] as const;
export type PayoutItemStatus = (typeof PAYOUT_ITEM_STATUSES)[number];

/** W09 status pill (data-model.md payout item state machine). */
export function payoutStatusLabel(status: PayoutItemStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Sent';
    case 'SUCCESS':
      return 'Paid out';
    case 'UNCLAIMED':
      return 'Waiting for you to claim';
    case 'FAILED':
      return 'Failed → retrying next batch';
    case 'RETURNED':
      return 'Returned → retrying next batch';
  }
}

/**
 * One line for a payout item: "$412.75 sent via PayPal" (PENDING), "$412.75 paid out via PayPal"
 * (SUCCESS), "$412.75 waiting for you to claim in PayPal" (UNCLAIMED). FAILED and RETURNED money is
 * back in the payable balance, so no money word is used.
 */
export function payoutLine(status: PayoutItemStatus, cents: number): string {
  const amount = formatCents(cents);
  switch (status) {
    case 'PENDING':
      return `${amount} ${MONEY_WORDS.sent} via PayPal`;
    case 'SUCCESS':
      return `${amount} ${MONEY_WORDS.paidOut} via PayPal`;
    case 'UNCLAIMED':
      return `${amount} ${MONEY_WORDS.waitingToClaim} in PayPal`;
    case 'FAILED':
    case 'RETURNED':
      return `${amount} back in your payable balance; retrying next batch`;
  }
}

// ---------------------------------------------------------------------------------------------
// W15 error & edge states

/** "This call costs $0.0555 and your balance is $0.012. Top up with PayPal: <link>." */
export function insufficientBalanceMessage(args: {
  priceMicros: number;
  balanceMicros: number;
  topUpUrl: string;
}): string {
  return (
    `This call costs ${formatMicros(args.priceMicros)} and your balance is ` +
    `${formatMicros(args.balanceMicros)}. ${TOP_UP_WITH_PAYPAL}: ${args.topUpUrl}.`
  );
}

/**
 * "This would return 1,000 records ($1.50), above your $1.00 per-call limit. Narrow the filters or
 * raise `max_price_micros`."
 */
export function priceAboveMaxMessage(args: {
  records: number;
  priceMicros: number;
  maxPriceMicros: number;
}): string {
  const noun = args.records === 1 ? 'record' : 'records';
  return (
    `This would return ${formatCount(args.records)} ${noun} (${formatMicros(args.priceMicros)}), ` +
    `above your ${formatMicros(args.maxPriceMicros)} per-call limit. ` +
    'Narrow the filters or raise `max_price_micros`.'
  );
}

/** "Auto top-up is at its $100 monthly cap. Top up by hand or raise the cap." */
export function autoTopupCapReachedMessage(args: { monthlyCapCents: number }): string {
  return (
    `Auto top-up is at its ${formatCents(args.monthlyCapCents)} monthly cap. ` +
    'Top up by hand or raise the cap.'
  );
}

/**
 * "PayPal declined the saved card. Auto top-up is off until you update it." A vaulted PayPal
 * wallet (behind `PAYPAL_WALLET_VAULT`) reads "the saved PayPal account".
 */
export function autoTopupDeclinedMessage(args: { method?: 'CARD' | 'PAYPAL' } = {}): string {
  const saved = args.method === 'PAYPAL' ? 'saved PayPal account' : 'saved card';
  return `PayPal declined the ${saved}. Auto top-up is off until you update it.`;
}

/** 410 `DATASET_UNPUBLISHED`. */
export const DATASET_UNPUBLISHED_MESSAGE = 'The owner stopped selling this data.';

/**
 * Human age for freshness copy: "45 s", "12 min", "6 h", "3 d". Floors to the unit, so it never
 * says data is fresher than it is.
 */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Stale-data freshness badge: "Last good extract 6 h ago; the site changed layout." */
export function staleDataMessage(args: { lastGoodExtractAgeMs: number }): string {
  return `Last good extract ${formatAge(args.lastGoodExtractAgeMs)} ago; the site changed layout.`;
}

/** "PayPal sent $412.75 to publisher@…, which has no PayPal account yet." */
export function payoutUnclaimedMessage(args: { amountCents: number; payoutEmail: string }): string {
  return (
    `PayPal sent ${formatCents(args.amountCents)} to ${args.payoutEmail}, ` +
    'which has no PayPal account yet.'
  );
}

/** "Your site returned 429. We paused and will retry after 10 min." */
export function crawlBlockedMessage(args: { httpStatus: number; retryAfterMs: number }): string {
  return (
    `Your site returned ${args.httpStatus}. ` +
    `We paused and will retry after ${formatAge(args.retryAfterMs)}.`
  );
}
