import { z } from 'zod';
import { audit } from '../audit/audit.js';
import type { Db } from '../db/index.js';
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { utcMonthWindow, VAULT_MIT_CAP_STATUSES } from './autoTopup.js';
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from './createTopup.js';

/**
 * W11's auto top-up card (screens.md §W11; api.md §`PUT /api/buyer/auto-topup`; SP-047b): what
 * the buyer set ("$20 when below $2, max $100/month"), the saved method, what is left of this UTC
 * month's cap, and the two W15 states (cap reached, declined).
 *
 * The cap counts every `VAULT_MIT` top-up (AUTO and MCP) the same way `reserveVaultTopup` does
 * (data-model rule 11), so "remaining this month" is what the next vault charge is checked against.
 */

/** A threshold above this is a typo, not a plan ($500, the largest single top-up). */
export const MAX_THRESHOLD_MICROS = MAX_TOPUP_CENTS * 10_000;
/** The monthly cap's ceiling ($5,000): ten maximum top-ups. */
export const MAX_MONTHLY_CAP_CENTS = MAX_TOPUP_CENTS * 10;

export const autoTopupBody = z
  .object({
    enabled: z.boolean(),
    amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
    thresholdMicros: z.number().int().min(0).max(MAX_THRESHOLD_MICROS),
    monthlyCapCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_MONTHLY_CAP_CENTS),
  })
  .strict()
  .refine((b) => b.monthlyCapCents >= b.amountCents, {
    message: 'The monthly cap must be at least the top-up amount.',
    path: ['monthlyCapCents'],
  });

export type AutoTopupInput = z.infer<typeof autoTopupBody>;

export interface AutoTopupSettings {
  enabled: boolean;
  amountCents: number;
  thresholdMicros: number;
  monthlyCapCents: number;
  /** This UTC month's `VAULT_MIT` top-ups (AUTO + MCP) that count against the cap. */
  usedThisMonthCents: number;
  remainingThisMonthCents: number;
  /** "Visa ••1111" / "PayPal · sb-buyer@…"; the vault id itself never leaves the server. */
  savedMethod: { kind: 'CARD' | 'PAYPAL'; label: string } | null;
  /** On, but the next top-up would pass the cap: W15 "Auto top-up is at its $100 monthly cap." */
  capReached: boolean;
  /** Set while the last vault top-up was declined and auto top-up is still off (W15 copy). */
  declinedAt: string | null;
}

interface SettingsRow {
  enabled: boolean;
  amountCents: number;
  thresholdMicros: string | number;
  capCents: number;
  vaultKind: 'CARD' | 'PAYPAL' | null;
  vaultLabel: string | null;
  vaulted: boolean;
  declinedAt: Date | null;
}

export async function getAutoTopupSettings(
  db: Queryable,
  buyerId: string,
  now: Date = new Date(),
): Promise<AutoTopupSettings> {
  const { start, end } = utcMonthWindow(now);
  const { rows } = await db.query<SettingsRow & { used: number }>(
    `SELECT b.auto_topup_enabled AS enabled, b.auto_topup_amount_cents AS "amountCents",
            b.auto_topup_threshold_micros AS "thresholdMicros",
            b.monthly_topup_cap_cents AS "capCents", b.vault_kind AS "vaultKind",
            b.vault_label AS "vaultLabel", b.vault_id IS NOT NULL AS vaulted,
            b.auto_topup_declined_at AS "declinedAt",
            (SELECT coalesce(sum(t.amount_cents), 0)::int FROM topups t
              WHERE t.buyer_id = b.id AND t.method = 'VAULT_MIT' AND t.status = ANY($2)
                AND t.created_at >= $3 AND t.created_at < $4) AS used
       FROM buyers b WHERE b.id = $1`,
    [buyerId, VAULT_MIT_CAP_STATUSES, start, end],
  );
  const r = rows[0];
  if (!r) throw new ApiError('NOT_FOUND', 'Buyer not found.');
  const remaining = Math.max(0, r.capCents - r.used);
  return {
    enabled: r.enabled,
    amountCents: r.amountCents,
    thresholdMicros: Number(r.thresholdMicros),
    monthlyCapCents: r.capCents,
    usedThisMonthCents: r.used,
    remainingThisMonthCents: remaining,
    savedMethod:
      r.vaulted && r.vaultKind
        ? {
            kind: r.vaultKind,
            label: r.vaultLabel ?? (r.vaultKind === 'CARD' ? 'Saved card' : 'PayPal'),
          }
        : null,
    capReached: r.enabled && r.amountCents > remaining,
    declinedAt: !r.enabled && r.declinedAt ? r.declinedAt.toISOString() : null,
  };
}

/**
 * `PUT /api/buyer/auto-topup`. Turning it on needs a saved method (422 `NO_SAVED_METHOD`); turning
 * it off, or changing the numbers while off, doesn't. Saving clears the declined state: the buyer
 * has seen it and chosen again. Locks the buyer row `FOR NO KEY UPDATE`, like `reserveVaultTopup`,
 * so a reservation sees either the old settings or the new ones, never half.
 */
export async function updateAutoTopupSettings(
  db: Db,
  buyerId: string,
  input: AutoTopupInput,
  now?: Date,
): Promise<AutoTopupSettings> {
  await db.tx(async (tx) => {
    const { rows } = await tx.query<SettingsRow>(
      `SELECT auto_topup_enabled AS enabled, auto_topup_amount_cents AS "amountCents",
              auto_topup_threshold_micros AS "thresholdMicros", monthly_topup_cap_cents AS "capCents",
              vault_id IS NOT NULL AS vaulted
         FROM buyers WHERE id = $1 FOR NO KEY UPDATE`,
      [buyerId],
    );
    const prev = rows[0];
    if (!prev) throw new ApiError('NOT_FOUND', 'Buyer not found.');
    if (input.enabled && !prev.vaulted) {
      throw new ApiError(
        'NO_SAVED_METHOD',
        'Auto top-up needs a saved payment method. Top up once with "Save for auto top-up" ' +
          'ticked, then turn auto top-up on.',
        { requires: 'saved_method' },
      );
    }
    await tx.query(
      `UPDATE buyers
          SET auto_topup_enabled = $2, auto_topup_amount_cents = $3,
              auto_topup_threshold_micros = $4, monthly_topup_cap_cents = $5,
              auto_topup_declined_at = NULL, updated_at = now()
        WHERE id = $1`,
      [buyerId, input.enabled, input.amountCents, input.thresholdMicros, input.monthlyCapCents],
    );
    await audit(tx, {
      actorType: 'BUYER',
      actorId: buyerId,
      entity: 'buyers',
      entityId: buyerId,
      action: 'SETTINGS_CHANGED',
      data: {
        autoTopup: {
          from: {
            enabled: prev.enabled,
            amountCents: prev.amountCents,
            thresholdMicros: Number(prev.thresholdMicros),
            monthlyCapCents: prev.capCents,
          },
          to: input,
        },
      },
    });
  });
  return getAutoTopupSettings(db.pool, buyerId, now);
}
