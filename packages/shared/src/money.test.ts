import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  centsToMicros,
  commissionSplit,
  formatCents,
  formatCount,
  formatMicros,
  formatPer1000,
  microsToCentsFloor,
} from './money.js';

describe('money units (data-model.md §Money units)', () => {
  it.each([
    [0, 0],
    [1, 10_000],
    [2000, 20_000_000],
    [41_275, 412_750_000],
  ])('centsToMicros(%i) = %i', (cents, micros) => {
    expect(centsToMicros(cents)).toBe(micros);
  });

  it.each([
    [12_345_678, 1234],
    [20_000_000, 2000],
    [9_999, 0],
    [10_000, 1],
    [412_752_000, 41_275],
    [0, 0],
    [-1, -1],
  ])('microsToCentsFloor(%i) = %i', (micros, cents) => {
    expect(microsToCentsFloor(micros)).toBe(cents);
  });

  it('round-trips cents through micros', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (c) => {
        expect(microsToCentsFloor(centsToMicros(c))).toBe(c);
      }),
    );
  });

  it('rejects non-integers', () => {
    expect(() => centsToMicros(1.5)).toThrow(RangeError);
    expect(() => microsToCentsFloor(Number.NaN)).toThrow(RangeError);
    expect(() => formatMicros(0.1)).toThrow(RangeError);
  });
});

describe('commissionSplit', () => {
  it.each([
    [1_500_000, 2000, 300_000, 1_200_000],
    [55_500, 2000, 11_100, 44_400],
    // Odd amounts: commission floors, the remainder stays with the publisher.
    [1, 2000, 0, 1],
    [7, 2000, 1, 6],
    [1_499, 2000, 299, 1_200],
    [3, 3333, 0, 3],
    [0, 2000, 0, 0],
    [1_500, 0, 0, 1_500],
    [1_500, 10_000, 1_500, 0],
  ])('commissionSplit(%i, %i) = %i / %i', (price, bps, commission, publisher) => {
    expect(commissionSplit(price, bps)).toEqual({ commission, publisher });
  });

  it('always sums to the price and floors the commission', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 10_000 }),
        (price, bps) => {
          const { commission, publisher } = commissionSplit(price, bps);
          expect(commission + publisher).toBe(price);
          expect(commission).toBeGreaterThanOrEqual(0);
          expect(publisher).toBeGreaterThanOrEqual(0);
          expect(BigInt(commission)).toBe((BigInt(price) * BigInt(bps)) / 10_000n);
        },
      ),
    );
  });

  it('rejects bad inputs', () => {
    expect(() => commissionSplit(-1, 2000)).toThrow(RangeError);
    expect(() => commissionSplit(100, 10_001)).toThrow(RangeError);
    expect(() => commissionSplit(100, -1)).toThrow(RangeError);
    expect(() => commissionSplit(100.5, 2000)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it.each([
    [55_500, '$0.0555'],
    [1_500, '$0.0015'],
    [1, '$0.000001'],
    [12_000, '$0.012'],
    [0, '$0.00'],
    [1_000_000, '$1.00'],
    [1_500_000, '$1.50'],
    [19_940_000, '$19.94'],
    [3_511_500, '$3.5115'],
    [412_752_000, '$412.752'],
    [1_234_567_890_000, '$1,234,567.89'],
    [-1_500, '-$0.0015'],
  ])('formatMicros(%i) = %s', (micros, text) => {
    expect(formatMicros(micros)).toBe(text);
  });

  it.each([
    [10_000, '$100'],
    [1_000, '$10'],
    [41_275, '$412.75'],
    [740, '$7.40'],
    [5, '$0.05'],
    [0, '$0'],
    [123_456_789, '$1,234,567.89'],
    [-740, '-$7.40'],
  ])('formatCents(%i) = %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('formatCount groups thousands', () => {
    expect(formatCount(2341)).toBe('2,341');
    expect(formatCount(1_000)).toBe('1,000');
    expect(formatCount(999)).toBe('999');
  });

  it('formatPer1000', () => {
    expect(formatPer1000(1_500)).toBe('$1.50 / 1,000 records');
    expect(formatPer1000(500, 'changes')).toBe('$0.50 / 1,000 changes');
    expect(formatPer1000(1)).toBe('$0.001 / 1,000 records');
  });

  it('formatMicros never loses a micro', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e15 }), (m) => {
        const digits = formatMicros(m).replace(/[$,]/g, '');
        const [whole = '', frac = ''] = digits.split('.');
        expect(BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'))).toBe(BigInt(m));
      }),
    );
  });
});
