import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool } from '../db/pool.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import type pg from 'pg';
import { getOrCreateAccount, platformAccounts, type PlatformAccounts } from './accounts.js';
import { ledgerCheck } from './check.js';
import { InsufficientBalance } from './errors.js';
import { post, type PostInput } from './ledger.js';
import {
  chargeEntries,
  creditEntries,
  payoutReturnedEntries,
  payoutSentEntries,
  payoutSettledEntries,
  refundEntries,
  topupEntries,
} from './postings.js';

const BUYERS = 3;
const PUBLISHERS = 2;
const amount = fc.integer({ min: 1, max: 5_000_000 });
const ix = fc.nat({ max: 1_000 });

const op = fc.oneof(
  fc.record({ t: fc.constant('topup' as const), b: ix, amount }),
  fc.record({
    t: fc.constant('charge' as const),
    b: ix,
    p: ix,
    amount,
    bps: fc.integer({ min: 0, max: 10_000 }),
  }),
  fc.record({ t: fc.constant('credit' as const), i: ix, amount }),
  fc.record({ t: fc.constant('refund' as const), b: ix, amount }),
  fc.record({ t: fc.constant('payoutSent' as const), p: ix, amount }),
  fc.record({ t: fc.constant('payoutSettled' as const), i: ix }),
  fc.record({ t: fc.constant('payoutReturned' as const), i: ix }),
  fc.record({ t: fc.constant('replay' as const), i: ix }),
);

describe.skipIf(!testDatabaseUrl)('ledger property (fast-check, real Postgres)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let platform: PlatformAccounts;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 4, applicationName: 'ledger-property' });
    db = createDb(pool);
    platform = await db.tx((tx) => platformAccounts(tx));
  });
  afterAll(async () => {
    await pool?.end();
    await tdb?.drop();
  });

  test('1k random sequences of top-up / charge / credit / refund / payout sent, settled, returned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        const { buyers, publishers } = await db.tx(async (tx) => {
          const buyers: string[] = [];
          const publishers: string[] = [];
          for (let i = 0; i < BUYERS; i++) {
            buyers.push(await getOrCreateAccount(tx, 'BUYER_BALANCE', randomUUID()));
          }
          for (let i = 0; i < PUBLISHERS; i++) {
            publishers.push(await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', randomUUID()));
          }
          return { buyers, publishers };
        });

        // A model of the buyer balances and payables, to compare with the database.
        const balance = new Map<string, number>([...buyers, ...publishers].map((id) => [id, 0]));
        const charges: { buyer: string; publisher: string; bps: number; creditable: number }[] = [];
        const inFlight: { publisher: string; amount: number }[] = [];
        const posted: PostInput[] = [];
        const apply = (input: PostInput) => {
          for (const e of input.entries) {
            if (balance.has(e.accountId))
              balance.set(e.accountId, balance.get(e.accountId)! + e.amountMicros);
          }
        };

        for (const o of ops) {
          let input: PostInput | undefined;
          const key = `${o.t}:${randomUUID()}`;
          switch (o.t) {
            case 'topup': {
              const buyer = buyers[o.b % BUYERS]!;
              input = {
                kind: 'TOPUP',
                idempotencyKey: key,
                entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, o.amount),
              };
              break;
            }
            case 'charge': {
              const buyer = buyers[o.b % BUYERS]!;
              const publisher = publishers[o.p % PUBLISHERS]!;
              const accounts = { buyer, publisher, platformRevenue: platform.platformRevenue };
              input = {
                kind: 'CHARGE',
                idempotencyKey: key,
                entries: chargeEntries(accounts, o.amount, o.bps),
              };
              if (balance.get(buyer)! >= o.amount) {
                charges.push({ buyer, publisher, bps: o.bps, creditable: o.amount });
              }
              break;
            }
            case 'credit': {
              const open = charges.filter((c) => c.creditable > 0);
              if (open.length === 0) continue;
              const c = open[o.i % open.length]!;
              const credit = Math.min(o.amount, c.creditable);
              c.creditable -= credit;
              const accounts = {
                buyer: c.buyer,
                publisher: c.publisher,
                platformRevenue: platform.platformRevenue,
              };
              input = {
                kind: 'CREDIT',
                idempotencyKey: key,
                entries: creditEntries(accounts, credit, c.bps),
              };
              break;
            }
            case 'refund': {
              const buyer = buyers[o.b % BUYERS]!;
              input = {
                kind: 'REFUND',
                idempotencyKey: key,
                entries: refundEntries({ buyer, paypalCash: platform.paypalCash }, o.amount),
              };
              break;
            }
            case 'payoutSent': {
              const publisher = publishers[o.p % PUBLISHERS]!;
              const payout = Math.min(o.amount, balance.get(publisher)!);
              if (payout <= 0) continue;
              inFlight.push({ publisher, amount: payout });
              input = {
                kind: 'PAYOUT_SENT',
                idempotencyKey: key,
                entries: payoutSentEntries(
                  { publisher, payoutsInFlight: platform.payoutsInFlight },
                  payout,
                ),
              };
              break;
            }
            case 'payoutSettled':
            case 'payoutReturned': {
              if (inFlight.length === 0) continue;
              const [item] = inFlight.splice(o.i % inFlight.length, 1);
              input =
                o.t === 'payoutSettled'
                  ? {
                      kind: 'PAYOUT_SETTLED',
                      idempotencyKey: key,
                      entries: payoutSettledEntries(
                        {
                          payoutsInFlight: platform.payoutsInFlight,
                          paypalCash: platform.paypalCash,
                        },
                        item!.amount,
                      ),
                    }
                  : {
                      kind: 'PAYOUT_RETURNED',
                      idempotencyKey: key,
                      entries: payoutReturnedEntries(
                        { payoutsInFlight: platform.payoutsInFlight, publisher: item!.publisher },
                        item!.amount,
                      ),
                    };
              break;
            }
            case 'replay': {
              if (posted.length === 0) continue;
              const original = posted[o.i % posted.length]!;
              const res = await db.tx((tx) => post(tx, original));
              expect(res.replay).toBe(true);
              continue;
            }
          }

          const buyerBefore = new Map(buyers.map((b) => [b, balance.get(b)!]));
          const debit = input.entries.find(
            (e) => buyerBefore.has(e.accountId) && e.amountMicros < 0,
          );
          const short =
            debit !== undefined && buyerBefore.get(debit.accountId)! + debit.amountMicros < 0;
          const p = input;
          const outcome = await db
            .tx((tx) => post(tx, p))
            .then(
              (r) => r,
              (err: unknown) => {
                if (err instanceof InsufficientBalance) return 'insufficient' as const;
                throw err;
              },
            );
          if (short) {
            expect(outcome).toBe('insufficient');
          } else {
            expect(outcome).toMatchObject({ replay: false });
            apply(input);
            posted.push(input);
          }

          const sum = await pool.query(
            `SELECT coalesce(sum(balance_micros), 0)::bigint AS s FROM ledger_accounts`,
          );
          expect(sum.rows[0].s).toBe(0);
        }

        const { rows } = await pool.query<{ id: string; balance_micros: number }>(
          `SELECT id, balance_micros FROM ledger_accounts WHERE id = ANY($1::uuid[])`,
          [[...buyers, ...publishers]],
        );
        for (const r of rows) expect(r.balance_micros).toBe(balance.get(r.id));
        const negative = await pool.query(
          `SELECT count(*)::int AS n FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND balance_micros < 0`,
        );
        expect(negative.rows[0].n).toBe(0);

        const check = await ledgerCheck(pool);
        expect(check.sumMicros).toBe(0);
        expect(check.mismatches).toEqual([]);
      }),
      { numRuns: 1_000 },
    );
  }, 300_000);

  test('ledgerCheck reports a balance that drifted from its entries', async () => {
    const buyer = await db.tx(async (tx) => {
      const id = await getOrCreateAccount(tx, 'BUYER_BALANCE', randomUUID());
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer: id, paypalCash: platform.paypalCash }, 1_000),
      });
      return id;
    });
    // Tampering on purpose to prove the check catches it; app code never does this.
    await pool.query(
      `UPDATE ledger_accounts SET balance_micros = balance_micros + 5 WHERE id = $1`,
      [buyer],
    );
    try {
      const check = await ledgerCheck(pool);
      expect(check.sumMicros).toBe(5);
      expect(check.mismatches).toEqual([
        { check: 'GLOBAL_SUM', expectedMicros: 0, actualMicros: 5 },
        expect.objectContaining({
          check: 'ACCOUNT_BALANCE',
          accountId: buyer,
          expectedMicros: 1_000,
          actualMicros: 1_005,
        }),
      ]);
    } finally {
      await pool.query(
        `UPDATE ledger_accounts SET balance_micros = balance_micros - 5 WHERE id = $1`,
        [buyer],
      );
    }
  });

  test('ledgerCheck reports a payable entry posted with the wrong sign', async () => {
    const publisher = await db.tx((tx) =>
      getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', randomUUID()),
    );
    // A hand-built (wrong) PAYOUT_SENT that credits the payable instead of debiting it.
    await db.tx((tx) =>
      post(tx, {
        kind: 'PAYOUT_SENT',
        idempotencyKey: `bad:${randomUUID()}`,
        entries: [
          { accountId: publisher, amountMicros: 700 },
          { accountId: platform.payoutsInFlight, amountMicros: -700 },
        ],
      }),
    );
    const check = await ledgerCheck(pool);
    expect(check.mismatches).toEqual([
      expect.objectContaining({
        check: 'PUBLISHER_PAYABLE',
        accountId: publisher,
        expectedMicros: -700,
        actualMicros: 700,
        payoutsSentMicros: 700,
      }),
    ]);
  });
});
