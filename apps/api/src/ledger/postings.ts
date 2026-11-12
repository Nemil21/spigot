import { commissionSplit } from '@spigot/shared';

/**
 * Entry builders for every money move, exactly as data-model §Postings. Sign convention:
 * liabilities (buyer balances, payables, revenue, payouts in flight) are positive, `PAYPAL_CASH`
 * (our asset at PayPal) is negative, and every txn sums to 0.
 *
 * Amounts are positive integer micros. A line that would be 0 (e.g. the commission on a 1-micro
 * charge) is dropped, because `ledger_entries.amount_micros` must be non-zero.
 */
export interface Entry {
  accountId: string;
  /** Signed integer micros, non-zero. */
  amountMicros: number;
}

function assertPositive(name: string, micros: number): void {
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new RangeError(`${name} must be a positive integer number of micros, got ${micros}`);
  }
}

function lines(...entries: Entry[]): Entry[] {
  return entries.filter((e) => e.amountMicros !== 0);
}

/** TOPUP: `PAYPAL_CASH −amount` · `BUYER_BALANCE(b) +amount`. */
export function topupEntries(
  a: { buyer: string; paypalCash: string },
  amountMicros: number,
): Entry[] {
  assertPositive('amountMicros', amountMicros);
  return lines(
    { accountId: a.paypalCash, amountMicros: -amountMicros },
    { accountId: a.buyer, amountMicros },
  );
}

export interface ChargeAccounts {
  buyer: string;
  publisher: string;
  platformRevenue: string;
}

/**
 * CHARGE: `BUYER_BALANCE(b) −price` · `PUBLISHER_PAYABLE(p) +(price − commission)` ·
 * `PLATFORM_REVENUE +commission`, with `commission = floor(price × bps / 10,000)`
 * (`commissionSplit`; the publisher keeps the rounding remainder).
 */
export function chargeEntries(
  a: ChargeAccounts,
  priceMicros: number,
  commissionBps: number,
): Entry[] {
  assertPositive('priceMicros', priceMicros);
  const { commission, publisher } = commissionSplit(priceMicros, commissionBps);
  return lines(
    { accountId: a.buyer, amountMicros: -priceMicros },
    { accountId: a.publisher, amountMicros: publisher },
    { accountId: a.platformRevenue, amountMicros: commission },
  );
}

/**
 * CREDIT (claim): the reverse of the CHARGE lines for the credited amount, split with the
 * commission rate the charge used (`api_calls.commission_bps`).
 */
export function creditEntries(
  a: ChargeAccounts,
  creditMicros: number,
  commissionBps: number,
): Entry[] {
  return chargeEntries(a, creditMicros, commissionBps).map((e) => ({
    accountId: e.accountId,
    amountMicros: -e.amountMicros,
  }));
}

/** REFUND to PayPal: `BUYER_BALANCE(b) −amount` · `PAYPAL_CASH +amount`. */
export function refundEntries(
  a: { buyer: string; paypalCash: string },
  amountMicros: number,
): Entry[] {
  assertPositive('amountMicros', amountMicros);
  return lines(
    { accountId: a.buyer, amountMicros: -amountMicros },
    { accountId: a.paypalCash, amountMicros },
  );
}

/** PAYOUT_SENT: `PUBLISHER_PAYABLE −amount` · `PAYOUTS_IN_FLIGHT +amount`. */
export function payoutSentEntries(
  a: { publisher: string; payoutsInFlight: string },
  amountMicros: number,
): Entry[] {
  assertPositive('amountMicros', amountMicros);
  return lines(
    { accountId: a.publisher, amountMicros: -amountMicros },
    { accountId: a.payoutsInFlight, amountMicros },
  );
}

/** PAYOUT_SETTLED: `PAYOUTS_IN_FLIGHT −amount` · `PAYPAL_CASH +amount`. */
export function payoutSettledEntries(
  a: { payoutsInFlight: string; paypalCash: string },
  amountMicros: number,
): Entry[] {
  assertPositive('amountMicros', amountMicros);
  return lines(
    { accountId: a.payoutsInFlight, amountMicros: -amountMicros },
    { accountId: a.paypalCash, amountMicros },
  );
}

/** PAYOUT_RETURNED (unclaimed / failed): `PAYOUTS_IN_FLIGHT −amount` · `PUBLISHER_PAYABLE +amount`. */
export function payoutReturnedEntries(
  a: { payoutsInFlight: string; publisher: string },
  amountMicros: number,
): Entry[] {
  assertPositive('amountMicros', amountMicros);
  return lines(
    { accountId: a.payoutsInFlight, amountMicros: -amountMicros },
    { accountId: a.publisher, amountMicros },
  );
}
