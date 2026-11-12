import { describe, expect, test } from 'vitest';
import { maskEmail, nextItemStatus } from './reconcile.js';
import { nextPayoutDate } from './view.js';

describe('nextItemStatus (payout item state machine)', () => {
  test.each([
    ['PENDING', 'SUCCESS', 'SUCCESS'],
    ['PENDING', 'UNCLAIMED', 'UNCLAIMED'],
    ['PENDING', 'FAILED', 'FAILED'],
    ['PENDING', 'BLOCKED', 'FAILED'],
    ['PENDING', 'DENIED', 'FAILED'],
    ['PENDING', 'REFUNDED', 'FAILED'],
    ['PENDING', 'RETURNED', 'FAILED'],
    ['PENDING', 'PENDING', null],
    ['PENDING', 'ONHOLD', null],
    ['PENDING', 'something-new', null],
    ['UNCLAIMED', 'SUCCESS', 'SUCCESS'],
    ['UNCLAIMED', 'RETURNED', 'RETURNED'],
    ['UNCLAIMED', 'BLOCKED', 'RETURNED'],
    ['UNCLAIMED', 'UNCLAIMED', null],
    ['UNCLAIMED', 'PENDING', null],
    ['SUCCESS', 'RETURNED', null],
    ['FAILED', 'SUCCESS', null],
    ['RETURNED', 'SUCCESS', null],
  ] as const)('%s + PayPal %s → %s', (from, paypal, to) => {
    expect(nextItemStatus(from, paypal)).toBe(to);
  });
});

describe('maskEmail', () => {
  test('keeps the local part only', () => {
    expect(maskEmail('publisher@example.com')).toBe('publisher@…');
    expect(maskEmail(null)).toBe('your payout email');
  });
});

describe('nextPayoutDate (Monday 09:00 PT)', () => {
  test.each([
    ['2026-11-12T03:30:00Z', '2026-11-16'], // Wed 19:30 PT
    ['2026-11-16T16:59:00Z', '2026-11-16'], // Mon 08:59 PST
    ['2026-11-16T17:00:00Z', '2026-11-23'], // Mon 09:00 PST
    ['2026-11-17T07:00:00Z', '2026-11-23'], // Mon 23:00 PST (Tue in UTC)
    ['2026-03-09T15:59:00Z', '2026-03-09'], // Mon 08:59 PDT
  ])('%s → %s', (now, date) => {
    expect(nextPayoutDate(new Date(now))).toBe(date);
  });
});
