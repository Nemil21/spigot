import type { Queryable } from '../db/pool.js';

/** `ledger_accounts.kind` (data-model §ledger_accounts). */
export const ACCOUNT_KINDS = [
  'BUYER_BALANCE',
  'PUBLISHER_PAYABLE',
  'PLATFORM_REVENUE',
  'PAYPAL_CASH',
  'PAYOUTS_IN_FLIGHT',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** One account each, `owner_id NULL`. */
export const PLATFORM_ACCOUNT_KINDS = [
  'PLATFORM_REVENUE',
  'PAYPAL_CASH',
  'PAYOUTS_IN_FLIGHT',
] as const;
export type PlatformAccountKind = (typeof PLATFORM_ACCOUNT_KINDS)[number];
export type OwnedAccountKind = Exclude<AccountKind, PlatformAccountKind>;

function isPlatformKind(kind: AccountKind): kind is PlatformAccountKind {
  return (PLATFORM_ACCOUNT_KINDS as readonly string[]).includes(kind);
}

/**
 * The account id for `(kind, ownerId)`, creating the row on first use. Buyer and publisher
 * accounts need the buyer / publisher id; platform accounts take `null`. Safe under concurrency:
 * the unique `(kind, owner_id)` (NULLS NOT DISTINCT) makes a racing insert a no-op, and the
 * follow-up SELECT sees the winner's row once it commits.
 */
export async function getOrCreateAccount(
  tx: Queryable,
  kind: PlatformAccountKind,
  ownerId?: null,
): Promise<string>;
export async function getOrCreateAccount(
  tx: Queryable,
  kind: OwnedAccountKind,
  ownerId: string,
): Promise<string>;
export async function getOrCreateAccount(
  tx: Queryable,
  kind: AccountKind,
  ownerId: string | null = null,
): Promise<string> {
  if (isPlatformKind(kind) !== (ownerId === null)) {
    throw new TypeError(
      isPlatformKind(kind)
        ? `${kind} is a platform account: ownerId must be null`
        : `${kind} needs an ownerId`,
    );
  }
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO ledger_accounts (kind, owner_id) VALUES ($1, $2)
     ON CONFLICT ON CONSTRAINT ledger_accounts_kind_owner_key DO NOTHING
     RETURNING id`,
    [kind, ownerId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM ledger_accounts WHERE kind = $1 AND owner_id IS NOT DISTINCT FROM $2`,
    [kind, ownerId],
  );
  const row = existing.rows[0];
  if (!row)
    throw new Error(`ledger account ${kind}/${ownerId ?? 'platform'} vanished after insert`);
  return row.id;
}

export interface PlatformAccounts {
  platformRevenue: string;
  paypalCash: string;
  payoutsInFlight: string;
}

/** The three platform account ids (created on first use). */
export async function platformAccounts(tx: Queryable): Promise<PlatformAccounts> {
  return {
    platformRevenue: await getOrCreateAccount(tx, 'PLATFORM_REVENUE'),
    paypalCash: await getOrCreateAccount(tx, 'PAYPAL_CASH'),
    payoutsInFlight: await getOrCreateAccount(tx, 'PAYOUTS_IN_FLIGHT'),
  };
}
