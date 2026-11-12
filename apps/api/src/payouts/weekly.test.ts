import { describe, expect, test } from 'vitest';
import { nextPayoutDate } from './view.js';
import { weeklySlot } from './weekly.js';

/** SP-060: the weekly slot is Monday 09:00 America/Los_Angeles, across DST. */

const slot = (iso: string) => weeklySlot(new Date(iso)).toISOString();

describe('weeklySlot', () => {
  test('PST: Monday 09:00 PT is 17:00 UTC', () => {
    expect(slot('2026-11-16T17:00:00.000Z')).toBe('2026-11-16T17:00:00.000Z');
    expect(slot('2026-11-16T17:04:59.000Z')).toBe('2026-11-16T17:00:00.000Z');
    expect(slot('2026-11-20T03:00:00.000Z')).toBe('2026-11-16T17:00:00.000Z');
  });

  test('a second before Monday 09:00 PT belongs to the previous week', () => {
    expect(slot('2026-11-16T16:59:59.999Z')).toBe('2026-11-09T17:00:00.000Z');
    // Monday 00:30 PT (08:30 UTC) is still last week.
    expect(slot('2026-11-16T08:30:00.000Z')).toBe('2026-11-09T17:00:00.000Z');
  });

  test('the PT calendar decides the day, not UTC (Sunday 20:00 PT is Monday in UTC)', () => {
    expect(slot('2026-11-16T04:00:00.000Z')).toBe('2026-11-09T17:00:00.000Z');
  });

  test('PDT: Monday 09:00 PT is 16:00 UTC', () => {
    expect(slot('2026-07-13T16:00:00.000Z')).toBe('2026-07-13T16:00:00.000Z');
    expect(slot('2026-07-13T15:59:59.000Z')).toBe('2026-07-06T16:00:00.000Z');
  });

  test('DST starts (Sun Mar 8 2026): the week before is PST, the Monday after PDT', () => {
    expect(slot('2026-03-08T20:00:00.000Z')).toBe('2026-03-02T17:00:00.000Z');
    expect(slot('2026-03-09T16:00:00.000Z')).toBe('2026-03-09T16:00:00.000Z');
  });

  test('DST ends (Sun Nov 1 2026): the week before is PDT, the Monday after PST', () => {
    expect(slot('2026-11-01T12:00:00.000Z')).toBe('2026-10-26T16:00:00.000Z');
    expect(slot('2026-11-02T16:30:00.000Z')).toBe('2026-10-26T16:00:00.000Z');
    expect(slot('2026-11-02T17:00:00.000Z')).toBe('2026-11-02T17:00:00.000Z');
  });

  test("agrees with W09's next-payout date: the next slot is the date it shows", () => {
    for (const iso of ['2026-11-12T12:00:00Z', '2026-11-16T16:59:00Z', '2026-03-07T12:00:00Z']) {
      const now = new Date(iso);
      const next = weeklySlot(new Date(weeklySlot(now).getTime() + 8 * 24 * 3_600_000));
      expect(next.getTime()).toBeGreaterThan(now.getTime());
      expect(nextPayoutDate(now)).toBe(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(next),
      );
    }
  });
});
