import { describe, expect, it } from 'vitest';
import { autoTopupCapReachedMessage, autoTopupDeclinedMessage } from '@spigot/shared';
import { autoTopupError, fitsMonthlyCap, utcMonthWindow, vaultSource } from './autoTopup.js';

describe('SP-047a auto top-up: cap math', () => {
  it('the month is the UTC calendar month, whatever the local time zone', () => {
    expect(utcMonthWindow(new Date('2026-11-12T08:30:00+05:30'))).toEqual({
      start: new Date('2026-11-01T00:00:00Z'),
      end: new Date('2026-12-01T00:00:00Z'),
    });
    // 23:30 on Oct 31 in New York is already November in UTC.
    expect(utcMonthWindow(new Date('2026-10-31T23:30:00-04:00')).start).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
    // 04:00 on Nov 1 in IST is still October in UTC.
    expect(utcMonthWindow(new Date('2026-11-01T04:00:00+05:30')).start).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
  });

  it('crosses month and year boundaries exactly', () => {
    expect(utcMonthWindow(new Date('2026-10-31T23:59:59.999Z')).end).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(utcMonthWindow(new Date('2026-11-01T00:00:00.000Z')).start).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(utcMonthWindow(new Date('2026-12-31T23:59:59Z'))).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
    expect(utcMonthWindow(new Date('2028-02-29T12:00:00Z')).end).toEqual(
      new Date('2028-03-01T00:00:00Z'),
    );
  });

  it('used + amount may equal the cap, never exceed it', () => {
    expect(fitsMonthlyCap({ usedCents: 8_000, amountCents: 2_000, monthlyCapCents: 10_000 })).toBe(
      true,
    );
    expect(fitsMonthlyCap({ usedCents: 8_001, amountCents: 2_000, monthlyCapCents: 10_000 })).toBe(
      false,
    );
    expect(fitsMonthlyCap({ usedCents: 0, amountCents: 2_000, monthlyCapCents: 1_000 })).toBe(
      false,
    );
  });
});

describe('SP-047a auto top-up: 402 and PayPal source', () => {
  it('maps the outcome to the 402 error (W15 copy)', () => {
    expect(autoTopupError({ result: 'CAP_REACHED', monthlyCapCents: 10_000 })).toEqual({
      code: 'AUTO_TOPUP_CAP_REACHED',
      message: autoTopupCapReachedMessage({ monthlyCapCents: 10_000 }),
    });
    expect(
      autoTopupError({ result: 'DECLINED', topupId: 't', code: 'X', vaultKind: 'PAYPAL' }),
    ).toEqual({ code: 'TOPUP_FAILED', message: autoTopupDeclinedMessage({ method: 'PAYPAL' }) });
    expect(autoTopupError({ result: 'SKIPPED', reason: 'TIMEOUT' })).toBeNull();
    expect(autoTopupError(null)).toBeNull();
  });

  it('charges a saved card as a MIT and a saved wallet by its vault id', () => {
    expect(vaultSource({ id: 'V1', kind: 'CARD' })).toEqual({ kind: 'card_vault', vaultId: 'V1' });
    expect(vaultSource({ id: 'V2', kind: 'PAYPAL' })).toEqual({
      kind: 'wallet_vault',
      vaultId: 'V2',
    });
  });
});
