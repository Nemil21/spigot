import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { twoPools, testDatabaseUrl, type TwoPools } from './test-db.js';
import { createDb, type Db } from './tx.js';
import { canTransition, InvalidTransitionError, transition } from './transition.js';

describe.skipIf(!testDatabaseUrl)('transition + db.tx', () => {
  let pools: TwoPools;
  let dbA: Db;
  let dbB: Db;
  let buyerId: string;

  beforeAll(async () => {
    pools = await twoPools();
    dbA = createDb(pools.a);
    dbB = createDb(pools.b);
    const { rows } = await pools.a.query(`INSERT INTO buyers (name) VALUES ('Acme') RETURNING id`);
    buyerId = rows[0].id;
  });
  afterAll(async () => {
    await pools?.close();
  });

  async function topup(status: string): Promise<string> {
    const { rows } = await pools.a.query(
      `INSERT INTO topups (buyer_id, amount_cents, status) VALUES ($1, 2000, $2) RETURNING id`,
      [buyerId, status],
    );
    return rows[0].id;
  }

  test('two concurrent transition(A -> B) from two pools: exactly one returns a row', async () => {
    for (let i = 0; i < 25; i++) {
      const id = await topup('AWAITING_APPROVAL');
      const results = await Promise.all(
        [dbA, dbB, dbA, dbB].map((db) =>
          db.tx(async (tx) => {
            const row = await transition(tx, 'topups', id, ['CREATED', 'AWAITING_APPROVAL'], 'COMPLETED', {
              paypal_capture_id: `CAP-${id}`,
            });
            // Hold the row lock a moment so the losers really wait on it.
            await tx.query('SELECT pg_sleep(0.005)');
            return row;
          }),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    }
  });

  test('the winner sees its extra columns; a stale `from` returns null', async () => {
    const id = await topup('CREATED');
    const row = await transition<'topups', { status: string; error_code: string }>(
      pools.a,
      'topups',
      id,
      'CREATED',
      'FAILED',
      { error_code: 'INSTRUMENT_DECLINED' },
    );
    expect(row).toMatchObject({ status: 'FAILED', error_code: 'INSTRUMENT_DECLINED' });
    expect(await transition(pools.a, 'topups', id, 'CREATED', 'AWAITING_APPROVAL')).toBeNull();
  });

  test('ABANDONED -> COMPLETED passes', async () => {
    const id = await topup('ABANDONED');
    const row = await transition(pools.a, 'topups', id, ['CREATED', 'AWAITING_APPROVAL', 'ABANDONED'], 'COMPLETED');
    expect(row).toMatchObject({ status: 'COMPLETED' });
  });

  test('UNCLAIMED -> SUCCESS passes', async () => {
    const { rows: p } = await pools.a.query(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', 'p@x.io', 'pay@x.io') RETURNING id`,
    );
    const { rows: b } = await pools.a.query(`INSERT INTO payout_batches (trigger) VALUES ('MANUAL_DEMO') RETURNING id`);
    const { rows: item } = await pools.a.query(
      `INSERT INTO payout_items (batch_id, publisher_id, status) VALUES ($1, $2, 'UNCLAIMED') RETURNING id`,
      [b[0].id, p[0].id],
    );
    const row = await transition(pools.a, 'payout_items', item[0].id, 'UNCLAIMED', 'SUCCESS');
    expect(row).toMatchObject({ status: 'SUCCESS' });
  });

  test('an edge outside the state machine throws before touching the database', async () => {
    const id = await topup('COMPLETED');
    await expect(transition(pools.a, 'topups', id, 'COMPLETED', 'CREATED')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(canTransition('datasets', 'LIVE', 'PROPOSED')).toBe(true); // DEMO_RESET
    expect(canTransition('datasets', 'REJECTED', 'PROPOSED')).toBe(false);
  });

  test('extra column names are validated', async () => {
    const id = await topup('CREATED');
    await expect(
      transition(pools.a, 'topups', id, 'CREATED', 'FAILED', { 'error_code"; DROP TABLE topups; --': 'x' }),
    ).rejects.toThrow(/bad extra column/);
    await expect(transition(pools.a, 'topups', id, 'CREATED', 'FAILED', { status: 'COMPLETED' })).rejects.toThrow(
      /bad extra column/,
    );
  });

  test('db.tx commits on resolve and rolls back on throw', async () => {
    const id = await topup('CREATED');
    await expect(
      dbA.tx(async (tx) => {
        await transition(tx, 'topups', id, 'CREATED', 'AWAITING_APPROVAL');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const before = await pools.a.query(`SELECT status FROM topups WHERE id = $1`, [id]);
    expect(before.rows[0].status).toBe('CREATED');

    await dbA.tx((tx) => transition(tx, 'topups', id, 'CREATED', 'AWAITING_APPROVAL'));
    const after = await pools.a.query(`SELECT status FROM topups WHERE id = $1`, [id]);
    expect(after.rows[0].status).toBe('AWAITING_APPROVAL');
  });

  test('int8 columns parse to numbers', async () => {
    const { rows } = await pools.a.query(`SELECT 9007199254740991::bigint AS max, 1500::bigint AS micros`);
    expect(rows[0]).toEqual({ max: Number.MAX_SAFE_INTEGER, micros: 1500 });
    await expect(pools.a.query(`SELECT 9007199254740993::bigint AS big`)).rejects.toThrow(/safe integer/);
  });
});
