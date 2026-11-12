import type { Queryable } from '../db/index.js';
import { isUniqueViolation } from './credentials.js';
import type { PayPalLoginIdentity } from './paypalOidc.js';

/**
 * What a verified PayPal identity does to `publishers` (SP-058). Race-safe without locks: the
 * unique indexes on `paypal_payer_id` and `email` decide, and a loser re-reads the winner.
 *
 * - `link` set (Connect with PayPal while signed in): that publisher gets `paypal_payer_id` and
 *   `payout_email` = the PayPal email. A payer id already on another publisher → `taken`.
 * - Otherwise (Log in with PayPal):
 *   - a publisher with this payer id → `signed-in` (its payout email is left alone: the publisher
 *     may have changed it in Settings since);
 *   - else a publisher whose login email is the PayPal email but isn't linked → `link-required`.
 *     We don't merge on email alone: the owner logs in with their password and connects from
 *     Settings, which proves they hold both;
 *   - else a new publisher (no password) with payout email = login email = PayPal email → `created`.
 */
export type PayPalSignIn =
  | { outcome: 'signed-in' | 'created' | 'linked'; publisherId: string }
  | { outcome: 'taken' | 'link-required' | 'not-found' };

export interface VerifiedPayPalIdentity extends PayPalLoginIdentity {
  payerId: string;
}

async function byPayerId(q: Queryable, payerId: string): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    'SELECT id FROM publishers WHERE paypal_payer_id = $1',
    [payerId],
  );
  return rows[0]?.id ?? null;
}

/** A display name for a new publisher: PayPal's name, else the email's local part. */
export function nameFor(identity: PayPalLoginIdentity): string {
  return (identity.name ?? identity.email.split('@', 1)[0]!).slice(0, 120);
}

export async function linkPayPal(
  q: Queryable,
  publisherId: string,
  identity: VerifiedPayPalIdentity,
): Promise<PayPalSignIn> {
  try {
    const { rows } = await q.query<{ id: string }>(
      `UPDATE publishers SET paypal_payer_id = $2, payout_email = $3, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [publisherId, identity.payerId, identity.email],
    );
    if (!rows[0]) return { outcome: 'not-found' };
    return { outcome: 'linked', publisherId };
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: 'taken' };
    throw err;
  }
}

export async function signInWithPayPal(
  q: Queryable,
  identity: VerifiedPayPalIdentity,
): Promise<PayPalSignIn> {
  const known = await byPayerId(q, identity.payerId);
  if (known) return { outcome: 'signed-in', publisherId: known };

  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO publishers (name, email, password_hash, paypal_payer_id, payout_email)
     SELECT $1, $2, NULL, $3, $2
      WHERE NOT EXISTS (SELECT 1 FROM publishers WHERE lower(email) = $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [nameFor(identity), identity.email, identity.payerId],
  );
  if (rows[0]) return { outcome: 'created', publisherId: rows[0].id };

  // Lost a race to a concurrent sign-in for the same payer, or the email is a password account.
  const winner = await byPayerId(q, identity.payerId);
  if (winner) return { outcome: 'signed-in', publisherId: winner };
  return { outcome: 'link-required' };
}
