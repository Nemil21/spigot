/**
 * PayPal amount strings ↔ integer cents. PayPal sends and takes USD as decimal strings
 * (`"20.00"`); Spigot keeps cents as integers (data-model.md §Money units). Never via floats.
 */

export function assertCents(value: number, name = 'amountCents'): void {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${name} must be an integer number of cents`);
}

/** `centsToDecimal(2005) = "20.05"`. */
export function centsToDecimal(cents: number): string {
  assertCents(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `decimalToCents("20.05") = 2005`. Throws on anything that isn't a 0–2 decimal place amount. */
export function decimalToCents(value: string): number {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a PayPal amount: ${JSON.stringify(value)}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  assertCents(cents, 'cents');
  return m[1] ? -cents : cents;
}

/** The `amount` object PayPal's Orders v2 API takes. */
export function paypalAmount(cents: number): { currency_code: 'USD'; value: string } {
  return { currency_code: 'USD', value: centsToDecimal(cents) };
}
