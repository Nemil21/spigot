import { describe, expect, it } from 'vitest';
import { effectiveThresholdCents, formatPeriod, payoutNote } from './buildBatch.js';

describe('payout note', () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`);

  it('formats the period like "Nov 4–11"', () => {
    expect(formatPeriod(d('2026-11-04'), d('2026-11-11'))).toBe('Nov 4–11');
    expect(formatPeriod(d('2026-10-28'), d('2026-11-03'))).toBe('Oct 28–Nov 3');
    expect(formatPeriod(d('2026-11-11'), d('2026-11-11'))).toBe('Nov 11');
    expect(formatPeriod(null, d('2026-11-11'))).toBe('Nov 11');
  });

  it('is "Spigot: N records sold, <period>"', () => {
    expect(payoutNote(8112, 'Nov 4–11')).toBe('Spigot: 8,112 records sold, Nov 4–11');
  });
});

describe('effectiveThresholdCents', () => {
  it("uses the publisher's threshold without an override", () => {
    expect(effectiveThresholdCents({ trigger: 'SCHEDULE' }, 1000)).toBe(1000);
  });

  it('demo override replaces it, never below $1', () => {
    expect(
      effectiveThresholdCents({ trigger: 'MANUAL_DEMO', thresholdCentsOverride: 250 }, 1000),
    ).toBe(250);
    expect(
      effectiveThresholdCents({ trigger: 'MANUAL_DEMO', thresholdCentsOverride: 1 }, 1000),
    ).toBe(100);
  });

  it('refuses an override on a SCHEDULE run or a non-integer', () => {
    expect(() =>
      effectiveThresholdCents({ trigger: 'SCHEDULE', thresholdCentsOverride: 100 }, 1000),
    ).toThrow(RangeError);
    expect(() =>
      effectiveThresholdCents({ trigger: 'MANUAL_DEMO', thresholdCentsOverride: 1.5 }, 1000),
    ).toThrow(RangeError);
  });
});
