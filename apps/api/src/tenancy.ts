import type { Queryable } from './db/index.js';
import { ApiError } from './http/errors.js';

/**
 * Tenancy (features/14 §Tenancy rules): every publisher query filters by the publisher id from
 * the session, never from the body. Routes build a scope from the session and use it for every
 * read and write:
 *
 *   const scope = forPublisher(requirePublisher(req).id);
 *   const site = await scope.get<Site>(app.db.pool, 'sites', req.params.id);  // 404 if not theirs
 *   const params: unknown[] = [];
 *   const where = scope.owns('datasets', 'd', params);   // "EXISTS (… s.publisher_id = $1)"
 *   await q.query(`SELECT d.* FROM datasets d WHERE ${where} AND d.status = $2`, [...params, 'LIVE']);
 *
 * Another publisher's row is a 404, never a 403: ids of other tenants are not confirmed to exist.
 */

/** How each tenant-scoped table reaches its publisher. */
const OWNERSHIP = {
  publishers: 'self',
  sites: 'publisher',
  payout_items: 'publisher',
  datasets: 'site',
  crawl_runs: 'site',
  pages: 'site',
  templates: 'site',
  bot_hits: 'site',
  records: 'dataset',
  record_versions: 'dataset',
  schema_versions: 'dataset',
} as const;

export type TenantTable = keyof typeof OWNERSHIP;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

export interface PublisherScope {
  readonly publisherId: string;
  /**
   * A SQL predicate limiting `alias` (a row of `table`) to this publisher. Pushes the publisher id
   * onto `params` and references it by position, so it composes with the caller's parameters.
   */
  owns(table: TenantTable, alias: string, params: unknown[]): string;
  /**
   * One row of `table` by `id`, or `404 NOT_FOUND` when it doesn't exist, isn't this publisher's,
   * or `id` isn't a uuid. `forUpdate` locks the row (inside a transaction).
   */
  get<T = Record<string, unknown>>(
    q: Queryable,
    table: Exclude<TenantTable, 'bot_hits'>,
    id: string,
    opts?: { columns?: string; forUpdate?: boolean },
  ): Promise<T>;
}

export function forPublisher(sessionPublisherId: string): PublisherScope {
  if (!isUuid(sessionPublisherId))
    throw new TypeError('forPublisher needs the session publisher id');
  const publisherId = sessionPublisherId;

  const owns: PublisherScope['owns'] = (table, alias, params) => {
    if (!IDENT.test(alias)) throw new TypeError(`Bad SQL alias: ${alias}`);
    params.push(publisherId);
    const p = `$${params.length}`;
    switch (OWNERSHIP[table]) {
      case 'self':
        return `${alias}.id = ${p}`;
      case 'publisher':
        return `${alias}.publisher_id = ${p}`;
      case 'site':
        return `EXISTS (SELECT 1 FROM sites t_s WHERE t_s.id = ${alias}.site_id AND t_s.publisher_id = ${p})`;
      case 'dataset':
        return (
          `EXISTS (SELECT 1 FROM datasets t_d JOIN sites t_s ON t_s.id = t_d.site_id` +
          ` WHERE t_d.id = ${alias}.dataset_id AND t_s.publisher_id = ${p})`
        );
      default:
        throw new TypeError(`Not a tenant table: ${String(table)}`);
    }
  };

  return {
    publisherId,
    owns,
    async get<T>(
      q: Queryable,
      table: Exclude<TenantTable, 'bot_hits'>,
      id: string,
      opts: { columns?: string; forUpdate?: boolean } = {},
    ): Promise<T> {
      if (!Object.hasOwn(OWNERSHIP, table) || table === ('bot_hits' as string)) {
        throw new TypeError(`Not a tenant table with an id: ${String(table)}`);
      }
      if (!isUuid(id)) throw notFound(table);
      const params: unknown[] = [id];
      const where = owns(table, 't', params);
      const { rows } = await q.query(
        `SELECT ${opts.columns ?? 't.*'} FROM ${table} t WHERE t.id = $1 AND ${where}` +
          (opts.forUpdate ? ' FOR UPDATE OF t' : ''),
        params,
      );
      if (!rows[0]) throw notFound(table);
      return rows[0] as T;
    },
  };
}

function notFound(table: string): ApiError {
  return new ApiError('NOT_FOUND', `No such ${table.replace(/s$/, '').replace(/_/g, ' ')}.`);
}
