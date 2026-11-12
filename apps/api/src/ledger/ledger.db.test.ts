import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { createDb, type Db, type Tx } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts, type PlatformAccounts } from './accounts.js';
import { ledgerCheck } from './check.js';
import { InsufficientBalance } from './errors.js';
import { post } from './ledger.js';
import { chargeEntries, topupEntries } from './postings.js';

describe.skipIf(!testDatabaseUrl)('ledger.post', () => {
  let pools: TwoPools;
  let dbA: Db;
  let dbB: Db;
  let platform: PlatformAccounts;

  beforeAll(async () => {
    pools = await twoPools();
    dbA = createDb(pools.a);
    dbB = createDb(pools.b);
    platform = await dbA.tx((tx) => platformAccounts(tx));
  });
  afterAll(async () => {
    await pools?.close();
  });

  async function balance(accountId: string): Promise<number> {
    const { rows } = await pools.a.query(
      `SELECT balance_micros FROM ledger_accounts WHERE id = $1`,
      [accountId],
    );
    return rows[0].balance_micros;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pools.a.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
    return rows[0].n;
  }

  async function newBuyer(topupMicros = 0): Promise<string> {
    return dbA.tx(async (tx) => {
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', randomUUID());
      if (topupMicros > 0) {
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, topupMicros),
        });
      }
      return buyer;
    });
  }

  async function newPublisher(): Promise<string> {
    return dbA.tx((tx) => getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', randomUUID()));
  }

  function charge(
    tx: Tx,
    buyer: string,
    publisher: string,
    price: number,
    key = `charge:${randomUUID()}`,
  ) {
    return post(tx, {
      kind: 'CHARGE',
      idempotencyKey: key,
      refType: 'api_call',
      entries: chargeEntries(
        { buyer, publisher, platformRevenue: platform.platformRevenue },
        price,
        2000,
      ),
    });
  }

  describe('accounts', () => {
    test('getOrCreateAccount is idempotent, also when two pools race', async () => {
      const owner = randomUUID();
      const ids = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? dbA : dbB).tx((tx) => getOrCreateAccount(tx, 'BUYER_BALANCE', owner)),
        ),
      );
      expect(new Set(ids).size).toBe(1);
      const again = await dbA.tx((tx) => platformAccounts(tx));
      expect(again).toEqual(platform);
      expect(await count(`ledger_accounts WHERE owner_id IS NULL`)).toBe(3);
    });

    test('platform accounts take no owner; buyer / publisher accounts need one', async () => {
      await expect(
        dbA.tx((tx) => getOrCreateAccount(tx, 'PLATFORM_REVENUE', randomUUID() as never)),
      ).rejects.toThrow(TypeError);
      await expect(
        dbA.tx((tx) => getOrCreateAccount(tx, 'BUYER_BALANCE', null as never)),
      ).rejects.toThrow(TypeError);
    });
  });

  test('same idempotency key twice → one txn, second call is a replay, balances unchanged', async () => {
    const buyer = await newBuyer();
    const key = `topup:${randomUUID()}`;
    const entries = topupEntries({ buyer, paypalCash: platform.paypalCash }, 20_000_000);
    const first = await dbA.tx((tx) => post(tx, { kind: 'TOPUP', idempotencyKey: key, entries }));
    expect(first.replay).toBe(false);
    if (!first.replay) {
      expect(first.balances[buyer]).toBe(20_000_000);
    }
    const cashAfterFirst = await balance(platform.paypalCash);

    const second = await dbB.tx((tx) => post(tx, { kind: 'TOPUP', idempotencyKey: key, entries }));
    expect(second).toMatchObject({
      replay: true,
      txn: { id: first.txn.id, kind: 'TOPUP', idempotencyKey: key },
    });
    expect(await count(`ledger_txns WHERE idempotency_key = $1`, [key])).toBe(1);
    expect(await count(`ledger_entries WHERE txn_id = $1`, [first.txn.id])).toBe(2);
    expect(await balance(buyer)).toBe(20_000_000);
    expect(await balance(platform.paypalCash)).toBe(cashAfterFirst);
  });

  test('commission split posts 300,000 platform / 1,200,000 publisher on a 1,500,000 charge', async () => {
    const buyer = await newBuyer(2_000_000);
    const publisher = await newPublisher();
    const revenueBefore = await balance(platform.platformRevenue);
    const res = await dbA.tx((tx) => charge(tx, buyer, publisher, 1_500_000));
    expect(res.replay).toBe(false);
    expect(await balance(buyer)).toBe(500_000);
    expect(await balance(publisher)).toBe(1_200_000);
    expect(await balance(platform.platformRevenue)).toBe(revenueBefore + 300_000);

    const pub2 = await newPublisher();
    await dbA.tx((tx) => charge(tx, buyer, pub2, 1_501));
    expect(await balance(pub2)).toBe(1_201);
    expect(await balance(platform.platformRevenue)).toBe(revenueBefore + 300_300);
  });

  test('a charge larger than the balance throws InsufficientBalance and writes nothing', async () => {
    const buyer = await newBuyer(50_000);
    const publisher = await newPublisher();
    const entriesBefore = await count('ledger_entries');
    const revenueBefore = await balance(platform.platformRevenue);
    const key = `charge:${randomUUID()}`;

    await expect(dbA.tx((tx) => charge(tx, buyer, publisher, 50_001, key))).rejects.toBeInstanceOf(
      InsufficientBalance,
    );
    expect(await count(`ledger_txns WHERE idempotency_key = $1`, [key])).toBe(0);
    expect(await count('ledger_entries')).toBe(entriesBefore);
    expect(await balance(buyer)).toBe(50_000);
    expect(await balance(publisher)).toBe(0);
    expect(await balance(platform.platformRevenue)).toBe(revenueBefore);
  });

  test('InsufficientBalance is a 402 INSUFFICIENT_BALANCE ApiError', () => {
    const err = new InsufficientBalance('charge:x');
    expect(err).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      status: 402,
      idempotencyKey: 'charge:x',
    });
  });

  test("after InsufficientBalance the caller's transaction is still usable and commits; no txn row", async () => {
    const buyer = await newBuyer(1_000);
    const publisher = await newPublisher();
    const key = `charge:${randomUUID()}`;
    const marker = `payment-required-${randomUUID()}`;

    const caught = await dbA.tx(async (tx) => {
      // Something the caller wrote before the post must survive too (SP-016's api_calls row).
      await tx.query(`INSERT INTO buyers (name) VALUES ($1)`, [`${marker}-before`]);
      let err: unknown;
      try {
        await charge(tx, buyer, publisher, 5_000, key);
      } catch (e) {
        err = e;
      }
      await tx.query(`INSERT INTO buyers (name) VALUES ($1)`, [`${marker}-after`]);
      // A second post in the same transaction still works (the savepoint was released).
      await charge(tx, buyer, publisher, 1_000);
      return err;
    });

    expect(caught).toBeInstanceOf(InsufficientBalance);
    expect(await count(`buyers WHERE name LIKE $1`, [`${marker}%`])).toBe(2);
    expect(await count(`ledger_txns WHERE idempotency_key = $1`, [key])).toBe(0);
    expect(await balance(buyer)).toBe(0);
    expect(await balance(publisher)).toBe(800);
  });

  test('simulatedAt without isSimulated throws; with it, the txn and all entries carry it', async () => {
    const buyer = await newBuyer();
    const simulatedAt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    simulatedAt.setMilliseconds(0);
    const entries = topupEntries({ buyer, paypalCash: platform.paypalCash }, 1_000_000);

    for (const isSimulated of [undefined, false]) {
      await expect(
        dbA.tx((tx) =>
          post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries,
            isSimulated,
            simulatedAt,
          }),
        ),
      ).rejects.toThrow(/simulatedAt/);
    }

    const key = `topup:${randomUUID()}`;
    const res = await dbA.tx((tx) =>
      post(tx, { kind: 'TOPUP', idempotencyKey: key, entries, isSimulated: true, simulatedAt }),
    );
    expect(res.txn).toMatchObject({ isSimulated: true, createdAt: simulatedAt });
    const { rows } = await pools.a.query(
      `SELECT created_at FROM ledger_entries WHERE txn_id = $1`,
      [res.txn.id],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.created_at).toEqual(simulatedAt);
  });

  test('unbalanced entries and unknown accounts are rejected without writing', async () => {
    const buyer = await newBuyer();
    await expect(
      dbA.tx((tx) =>
        post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: [
            { accountId: buyer, amountMicros: 10 },
            { accountId: platform.paypalCash, amountMicros: -9 },
          ],
        }),
      ),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      dbA.tx((tx) =>
        post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer: randomUUID(), paypalCash: platform.paypalCash }, 10),
        }),
      ),
    ).rejects.toThrow(/unknown ledger account/);
    await expect(
      dbA.tx((tx) =>
        post(tx, { kind: 'TOPUP', idempotencyKey: `topup:${randomUUID()}`, entries: [] }),
      ),
    ).rejects.toThrow(RangeError);
    expect(await balance(buyer)).toBe(0);
  });

  describe('races', () => {
    test('50 parallel posts with one key (two pools) → one txn', async () => {
      const buyer = await newBuyer();
      const key = `topup:${randomUUID()}`;
      const entries = topupEntries({ buyer, paypalCash: platform.paypalCash }, 5_000_000);
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          (i % 2 ? dbA : dbB).tx(async (tx) => {
            const r = await post(tx, { kind: 'TOPUP', idempotencyKey: key, entries });
            // Hold the locks a moment so the others really queue on the key.
            await tx.query('SELECT pg_sleep(0.002)');
            return r;
          }),
        ),
      );
      expect(results.filter((r) => !r.replay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.txn.id)).size).toBe(1);
      expect(await count(`ledger_txns WHERE idempotency_key = $1`, [key])).toBe(1);
      expect(await balance(buyer)).toBe(5_000_000);
    });

    test('50 parallel charges per buyer on a $0.05 balance, two buyers into one publisher → ≤ $0.05 each, no deadlock', async () => {
      const BALANCE = 50_000; // $0.05
      const PRICE = 7_000;
      const buyers = [await newBuyer(BALANCE), await newBuyer(BALANCE)];
      const publisher = await newPublisher();

      const outcomes = await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          const buyer = buyers[i % 2]!;
          return (i % 3 ? dbA : dbB)
            .tx(async (tx) => {
              const accounts = { buyer, publisher, platformRevenue: platform.platformRevenue };
              const entries = chargeEntries(accounts, PRICE, 2000);
              // Vary the entry order: the locks must still be taken in id order.
              if (i % 4 < 2) entries.reverse();
              await post(tx, { kind: 'CHARGE', idempotencyKey: `charge:${randomUUID()}`, entries });
              return { buyer, ok: true as const };
            })
            .catch((err: unknown) => {
              if (err instanceof InsufficientBalance) return { buyer, ok: false as const };
              throw err; // a deadlock (40P01) or anything else fails the test
            });
        }),
      );

      const maxCharges = Math.floor(BALANCE / PRICE); // 7
      for (const buyer of buyers) {
        const mine = outcomes.filter((o) => o.buyer === buyer);
        const charged = mine.filter((o) => o.ok).length;
        expect(charged).toBe(maxCharges);
        expect(mine.length - charged).toBe(50 - maxCharges);
        expect(await balance(buyer)).toBe(BALANCE - charged * PRICE);
        expect(await balance(buyer)).toBeGreaterThanOrEqual(0);
      }
      expect(await balance(publisher)).toBe(2 * maxCharges * (PRICE - 1_400));

      const check = await ledgerCheck(pools.a);
      expect(check.mismatches).toEqual([]);
      expect(check.sumMicros).toBe(0);
    });
  });
});
