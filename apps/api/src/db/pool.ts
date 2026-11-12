import pg from 'pg';

/**
 * Postgres pool factory (SP-002). The schema is `db/migrations` (`npm run migrate`).
 *
 * int8 / bigint columns (micros, seqs, bigserial ids) parse to `number`, not pg's default
 * string. Micros stay well inside Number.MAX_SAFE_INTEGER (that is ~$9 billion); a value
 * beyond it throws instead of silently losing precision.
 */
const INT8_OID = 20;

function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  return n;
}

const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID && format !== 'binary') return parseInt8;
    return pg.types.getTypeParser(oid, format as 'text');
  },
} as pg.CustomTypesConfig;

export interface PoolOptions {
  max?: number;
  /** Shows in pg_stat_activity, e.g. `spigot-api` or `spigot-jobs`. */
  applicationName?: string;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'spigot-api',
    types,
  });
  // An idle client erroring (e.g. the server restarted) must not crash the process; the pool
  // drops that client and the next checkout gets a fresh one.
  pool.on('error', () => {});
  return pool;
}

/** Anything that can run a query: a pool, a client, or a transaction. */
export type Queryable = Pick<pg.ClientBase, 'query'>;
