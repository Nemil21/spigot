/**
 * Money units (data-model.md §Money units).
 * - The ledger and every per-call price are integer **micros** (1 USD = 1,000,000 micros).
 * - Anything sent to or received from PayPal (top-ups, refunds, payouts) is integer **cents**.
 * This file is the one place the two meet. Amounts are JS numbers holding integers; every helper
 * rejects non-integers so a float never reaches the ledger.
 */

export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_DOLLAR = 1_000_000;
/** Basis points in 100%: `commission_bps` 2000 = 20%. */
export const BPS_DENOMINATOR = 10_000;

function assertInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}

/** `centsToMicros(2000) = 20_000_000`. */
export function centsToMicros(cents: number): number {
  assertInteger('cents', cents);
  const micros = cents * MICROS_PER_CENT;
  assertInteger('micros', micros);
  return micros;
}

/**
 * `microsToCentsFloor(12_345_678) = 1234`. Rounds **down** (toward negative infinity): payout
 * amounts never exceed what is owed, and the sub-cent remainder stays in the publisher's payable
 * for the next batch.
 */
export function microsToCentsFloor(micros: number): number {
  assertInteger('micros', micros);
  return Math.floor(micros / MICROS_PER_CENT);
}

export interface CommissionSplit {
  /** Spigot's cut: `floor(price × bps / 10,000)`. */
  commission: number;
  /** Everything else, so `commission + publisher === price` exactly. */
  publisher: number;
}

/**
 * Split a charge between Spigot and the publisher. Commission is floored; the remainder (including
 * any odd micro) goes to the publisher. `commissionSplit(1_500_000, 2000)` = 300,000 / 1,200,000.
 */
export function commissionSplit(priceMicros: number, bps: number): CommissionSplit {
  assertInteger('priceMicros', priceMicros);
  assertInteger('bps', bps);
  if (priceMicros < 0) throw new RangeError(`priceMicros must be >= 0, got ${priceMicros}`);
  if (bps < 0 || bps > BPS_DENOMINATOR) {
    throw new RangeError(`bps must be between 0 and ${BPS_DENOMINATOR}, got ${bps}`);
  }
  // BigInt so price × bps can't lose precision above 2^53.
  const commission = Number((BigInt(priceMicros) * BigInt(bps)) / BigInt(BPS_DENOMINATOR));
  return { commission, publisher: priceMicros - commission };
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Exact dollar string for micros, with as many decimals as the amount needs (2 to 6), so a charge
 * is never rounded away (screens.md money copy rule: "$0.0555").
 * `formatMicros(55_500)` → "$0.0555", `formatMicros(1_500_000)` → "$1.50",
 * `formatMicros(12_000)` → "$0.012", `formatMicros(-1_500)` → "-$0.0015".
 */
export function formatMicros(micros: number): string {
  assertInteger('micros', micros);
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / MICROS_PER_DOLLAR);
  const fraction = String(abs % MICROS_PER_DOLLAR)
    .padStart(6, '0')
    .replace(/0{1,4}$/, '');
  const decimals = fraction.padEnd(2, '0');
  return `${micros < 0 ? '-' : ''}$${groupThousands(String(dollars))}.${decimals}`;
}

/**
 * Dollar string for PayPal cents. Whole dollars drop the cents ("$100 monthly cap", "threshold
 * $10"); anything else shows two decimals ("$412.75").
 */
export function formatCents(cents: number): string {
  assertInteger('cents', cents);
  const abs = Math.abs(cents);
  const dollars = groupThousands(String(Math.floor(abs / 100)));
  const rest = abs % 100;
  const body = rest === 0 ? dollars : `${dollars}.${String(rest).padStart(2, '0')}`;
  return `${cents < 0 ? '-' : ''}$${body}`;
}

/** A count with thousands separators: 2341 → "2,341". */
export function formatCount(n: number): string {
  assertInteger('n', n);
  return `${n < 0 ? '-' : ''}${groupThousands(String(Math.abs(n)))}`;
}

/**
 * Price per 1,000 units, the way every screen shows a rate (screens.md money copy rule):
 * `formatPer1000(1500)` → "$1.50 / 1,000 records"; `formatPer1000(500, 'changes')` →
 * "$0.50 / 1,000 changes".
 */
export function formatPer1000(perUnitMicros: number, unit = 'records'): string {
  assertInteger('perUnitMicros', perUnitMicros);
  return `${formatMicros(perUnitMicros * 1000)} / 1,000 ${unit}`;
}
