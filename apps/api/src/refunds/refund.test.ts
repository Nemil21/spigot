import { describe, expect, it } from 'vitest';
import { assertRefundAmount, planSlices, type RefundSource } from './refund.js';

const src = (topupId: string, day: number, refundableCents: number): RefundSource => ({
  topupId,
  captureId: `CAP-${topupId}`,
  createdAt: new Date(Date.UTC(2026, 10, day)),
  refundableCents,
});

describe('planSlices (SP-049 refundable-amount split)', () => {
  it('takes one slice from the newest top-up when it covers the amount', () => {
    expect(planSlices([src('a', 1, 2000), src('b', 5, 2000)], 740)).toEqual([
      { topupId: 'b', captureId: 'CAP-b', amountCents: 740 },
    ]);
  });

  it('splits newest first and drains each capture before the next', () => {
    expect(
      planSlices([src('old', 1, 2000), src('new', 9, 1000), src('mid', 5, 300)], 1500),
    ).toEqual([
      { topupId: 'new', captureId: 'CAP-new', amountCents: 1000 },
      { topupId: 'mid', captureId: 'CAP-mid', amountCents: 300 },
      { topupId: 'old', captureId: 'CAP-old', amountCents: 200 },
    ]);
  });

  it('skips fully refunded (or fully held) captures', () => {
    expect(planSlices([src('a', 1, 500), src('b', 9, 0)], 500)).toEqual([
      { topupId: 'a', captureId: 'CAP-a', amountCents: 500 },
    ]);
  });

  it('breaks createdAt ties by id, descending, so the split is deterministic', () => {
    expect(planSlices([src('a', 3, 100), src('b', 3, 100)], 150)).toEqual([
      { topupId: 'b', captureId: 'CAP-b', amountCents: 100 },
      { topupId: 'a', captureId: 'CAP-a', amountCents: 50 },
    ]);
  });

  it('returns null when the captures cannot cover the amount', () => {
    expect(planSlices([src('a', 1, 500)], 501)).toBeNull();
    expect(planSlices([], 1)).toBeNull();
  });
});

describe('assertRefundAmount', () => {
  it.each([0, -1, 1.5, '740', null, Number.MAX_SAFE_INTEGER])('rejects %s', (v) => {
    expect(() => assertRefundAmount(v)).toThrow(/positive whole number/);
  });
  it('accepts whole positive cents', () => {
    expect(() => assertRefundAmount(740)).not.toThrow();
  });
});
