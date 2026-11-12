import type pg from 'pg';
import type { Queryable } from './pool.js';

/**
 * Postgres advisory locks keyed by readable names (SP-002).
 *
 * Names are hashed server-side with `hashtextextended(name, 0)` to the bigint key, so every
 * caller that uses the same name, in any process, takes the same lock. Conventions:
 * `dataset:<id>` (SP-013 watermark), `payout` (SP-020), `job:<name>` (runEvery).
 */

/**
 * Take a transaction-scoped lock, released at COMMIT / ROLLBACK. Waits for it.
 * `shared: true` takes the shared mode (many holders; excludes the exclusive mode), e.g.
 * SP-013's extract batches share `dataset:<id>` while `publishWatermark` takes it exclusive.
 * Must be called on a connection inside a transaction (`db.tx`).
 */
export async function withAdvisoryXactLock(
  tx: Queryable,
  key: string,
  opts: { shared?: boolean } = {},
): Promise<void> {
  const fn = opts.shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await tx.query(`SELECT ${fn}(hashtextextended($1, 0))`, [key]);
}

/** Transaction-scoped lock without waiting: `false` means someone else holds it. */
export async function tryAdvisoryXactLock(tx: Queryable, key: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok',
    [key],
  );
  return rows[0]?.ok === true;
}

export interface AdvisoryLock {
  /** The dedicated connection holding the lock; usable for queries while held. */
  readonly client: pg.PoolClient;
  /** Unlock and return the connection to the pool. Safe to call twice. */
  release(): Promise<void>;
}

/**
 * Session-scoped lock on a dedicated pool connection, without waiting. Returns `null` when
 * another session holds it. The lock lives as long as the connection, so always `release()`
 * (in a `finally`). If the process dies, Postgres drops the lock with the connection.
 */
export async function tryAdvisoryLock(pool: pg.Pool, name: string): Promise<AdvisoryLock | null> {
  const client = await pool.connect();
  let ok = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [name],
    );
    ok = rows[0]?.ok === true;
  } catch (err) {
    client.release(err instanceof Error ? err : undefined);
    throw err;
  }
  if (!ok) {
    client.release();
    return null;
  }

  let released = false;
  return {
    client,
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]);
        client.release();
      } catch (err) {
        // Destroy the connection so the lock can't leak back into the pool.
        client.release(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
