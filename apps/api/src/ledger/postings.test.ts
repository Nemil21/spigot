import { describe, expect, test } from 'vitest';
import {
  chargeEntries,
  creditEntries,
  payoutReturnedEntries,
  payoutSentEntries,
  payoutSettledEntries,
  refundEntries,
  topupEntries,
  type Entry,
} from './postings.js';

const A = { buyer: 'b', publisher: 'p', platformRevenue: 'rev' };
const sum = (es: Entry[]) => es.reduce((s, e) => s + e.amountMicros, 0);

describe('postings (data-model §Postings)', () => {
  test('TOPUP $20', () => {
    expect(topupEntries({ buyer: 'b', paypalCash: 'cash' }, 20_000_000)).toEqual([
      { accountId: 'cash', amountMicros: -20_000_000 },
      { accountId: 'b', amountMicros: 20_000_000 },
    ]);
  });

  test('CHARGE 1,500,000 at 2000 bps → 300,000 platform / 1,200,000 publisher', () => {
    expect(chargeEntries(A, 1_500_000, 2000)).toEqual([
      { accountId: 'b', amountMicros: -1_500_000 },
      { accountId: 'p', amountMicros: 1_200_000 },
      { accountId: 'rev', amountMicros: 300_000 },
    ]);
  });

  test('CHARGE 1,501 at 2000 bps → 300 platform / 1,201 publisher (floor commission)', () => {
    expect(chargeEntries(A, 1_501, 2000)).toEqual([
      { accountId: 'b', amountMicros: -1_501 },
      { accountId: 'p', amountMicros: 1_201 },
      { accountId: 'rev', amountMicros: 300 },
    ]);
  });

  test('a zero commission line is dropped (entries must be non-zero)', () => {
    expect(chargeEntries(A, 4, 2000)).toEqual([
      { accountId: 'b', amountMicros: -4 },
      { accountId: 'p', amountMicros: 4 },
    ]);
  });

  test('CREDIT reverses the CHARGE lines for the credited amount', () => {
    expect(creditEntries(A, 1_501, 2000)).toEqual([
      { accountId: 'b', amountMicros: 1_501 },
      { accountId: 'p', amountMicros: -1_201 },
      { accountId: 'rev', amountMicros: -300 },
    ]);
  });

  test('REFUND and payouts', () => {
    expect(refundEntries({ buyer: 'b', paypalCash: 'cash' }, 7_400_000)).toEqual([
      { accountId: 'b', amountMicros: -7_400_000 },
      { accountId: 'cash', amountMicros: 7_400_000 },
    ]);
    expect(payoutSentEntries({ publisher: 'p', payoutsInFlight: 'fl' }, 12_000_000)).toEqual([
      { accountId: 'p', amountMicros: -12_000_000 },
      { accountId: 'fl', amountMicros: 12_000_000 },
    ]);
    expect(payoutSettledEntries({ payoutsInFlight: 'fl', paypalCash: 'cash' }, 12_000_000)).toEqual(
      [
        { accountId: 'fl', amountMicros: -12_000_000 },
        { accountId: 'cash', amountMicros: 12_000_000 },
      ],
    );
    expect(payoutReturnedEntries({ payoutsInFlight: 'fl', publisher: 'p' }, 12_000_000)).toEqual([
      { accountId: 'fl', amountMicros: -12_000_000 },
      { accountId: 'p', amountMicros: 12_000_000 },
    ]);
  });

  test('every builder balances; non-positive or fractional amounts throw', () => {
    for (const es of [
      topupEntries({ buyer: 'b', paypalCash: 'c' }, 7),
      chargeEntries(A, 999_999, 1234),
      creditEntries(A, 999_999, 1234),
      refundEntries({ buyer: 'b', paypalCash: 'c' }, 7),
    ]) {
      expect(sum(es)).toBe(0);
    }
    expect(() => chargeEntries(A, 0, 2000)).toThrow(RangeError);
    expect(() => topupEntries({ buyer: 'b', paypalCash: 'c' }, -1)).toThrow(RangeError);
    expect(() => payoutSentEntries({ publisher: 'p', payoutsInFlight: 'f' }, 1.5)).toThrow(
      RangeError,
    );
  });
});
