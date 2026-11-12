import type pg from 'pg';

/** A connection with an open transaction, handed to the `db.tx` callback. */
export type Tx = pg.PoolClient;

export interface Db {
  readonly pool: pg.Pool;
  /**
   * Run `fn` in one transaction on a dedicated connection: COMMIT when it resolves, ROLLBACK
   * when it throws (the error is rethrown). Never call PayPal inside `fn`: hold no row locks
   * across a network call.
   */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createDb(pool: pg.Pool): Db {
  return {
    pool,
    async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // The connection is unusable; drop it from the pool instead of returning it.
          broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
  };
}
