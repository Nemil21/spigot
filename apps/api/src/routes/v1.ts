import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import {
  apiKeyRateLimit,
  authenticateBearer,
  requireApiKey,
  requireScope,
} from '../auth/apiKeys.js';
import { parse } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';
import { balance } from '../services/balance.js';
import { catalog } from '../services/catalog.js';
import { describe } from '../services/describe.js';
import {
  paidRead,
  paymentRequired,
  type PaidReadContext,
  type PaidReadParams,
  type PaidReadResult,
} from '../services/paidRead.js';
import type { Headers402 } from '../services/payment402.js';
import { quote } from '../services/quote.js';
import {
  changesQuery,
  datasetParams,
  idempotencyKeyHeader,
  quoteQuery,
  recordParams,
  recordQuery,
  recordsQuery,
} from './v1.schemas.js';

/**
 * The buyer data API (api.md §Buyer data API; features/06 §Endpoints, §Rate limits; SP-017b).
 * Thin routes over SP-017a's services, which MCP (SP-022a) shares:
 *
 * - `GET /v1/catalog`, `GET /v1/:site/datasets/:dataset`: free, no key.
 * - `GET …/quote` (free) and `GET /v1/balance`: API key.
 * - `GET …/records`, `…/records/:key`, `…/changes`: paid. Bearer key with the `read` scope,
 *   optional `Idempotency-Key`, optional `max_price_micros`. Every 2xx carries `Spigot-Charged-
 *   Micros`, `Spigot-Balance-Micros`, `Spigot-Records`, `Spigot-Call-Id` (and `Spigot-Replay:
 *   true` on a replay). A 402 carries the gate's `Link` / `Spigot-Price` / `Cache-Control`.
 *   **No key → 402 `PAYMENT_REQUIRED`** with the gate-shaped body (not 401); a key that is
 *   malformed, unknown or revoked → 401.
 * - Keyed routes: 60 calls/min per key (the key's `rate_limit_per_min`) → 429 `RATE_LIMITED` +
 *   `Retry-After`. Keyless calls to paid routes are limited the same way per client IP.
 *
 * Request and response schemas live in `v1.schemas.ts` (SP-023 builds openapi.yaml from them).
 * Tenancy: `security/tenancy/v1.cases.ts`.
 */

/** Paid routes: authenticate only when a key is sent; no `Authorization` at all → the 402 path. */
const optionalBearer: onRequestAsyncHookHandler = async function optionalBearer(req, reply) {
  if (req.headers.authorization === undefined) return;
  await authenticateBearer.call(this, req, reply);
};

const byKeyOrIp = (() => {
  const byKey = apiKeyRateLimit('rest');
  const byIp = rateLimit('rest', (req) => `anon:${req.ip}`);
  const limit: preHandlerAsyncHookHandler = async function (req, reply) {
    await (req.apiKey ? byKey : byIp).call(this, req, reply);
  };
  return limit;
})();

const readScope = requireScope('read');
const readScopeIfKeyed: preHandlerAsyncHookHandler = async function (req, reply) {
  if (req.apiKey) await readScope.call(this, req, reply);
};

const keyed = { onRequest: authenticateBearer, preHandler: [apiKeyRateLimit('rest')] };
const paid = { onRequest: optionalBearer, preHandler: [byKeyOrIp, readScopeIfKeyed] };

function send402(reply: FastifyReply, headers: Headers402 | null): void {
  if (headers) reply.headers(headers as unknown as Record<string, string | string[]>);
}

function sendPaid(reply: FastifyReply, r: PaidReadResult): FastifyReply {
  if (r.status >= 200 && r.status < 300) {
    reply.header('Spigot-Charged-Micros', String(r.chargedMicros));
    reply.header('Spigot-Balance-Micros', String(r.balanceMicros));
    reply.header('Spigot-Records', String(r.count));
    if (r.callId) reply.header('Spigot-Call-Id', r.callId);
    if (r.replay) reply.header('Spigot-Replay', 'true');
  } else {
    send402(reply, r.headers);
  }
  return reply.code(r.status).send(r.body);
}

const v1Routes: FastifyPluginAsync = async (app) => {
  const baseUrl = app.config.APP_BASE_URL;

  /**
   * One paid read. No key → the gate-shaped 402 (unknown site/dataset still 404, unpublished
   * 410). Otherwise SP-017a's `paidRead` on the REST channel.
   */
  async function read(
    req: FastifyRequest,
    reply: FastifyReply,
    params: Omit<PaidReadParams, 'idempotencyKey'>,
  ): Promise<FastifyReply> {
    if (!req.apiKey) {
      const r = await paymentRequired({ db: app.db.pool, baseUrl }, params.site, params.dataset);
      send402(reply, r.headers);
      return reply.code(r.status).send(r.body);
    }
    const key = requireApiKey(req);
    const idempotencyKey = parse(
      idempotencyKeyHeader,
      req.headers['idempotency-key'],
      'Idempotency-Key header',
    );
    const ctx: PaidReadContext = {
      db: app.db,
      buyerId: key.buyerId,
      apiKeyId: key.id,
      channel: 'REST',
      baseUrl,
    };
    const r = await paidRead(ctx, {
      ...params,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    return sendPaid(reply, r);
  }

  app.get('/v1/catalog', async () => catalog(app.db.pool));

  app.get('/v1/:site/datasets/:dataset', async (req) => {
    const p = parse(datasetParams, req.params, 'path');
    return describe({ db: app.db.pool, baseUrl }, p.site, p.dataset);
  });

  app.get(
    '/v1/:site/datasets/:dataset/quote',
    { ...keyed, preHandler: [...keyed.preHandler, readScope] },
    async (req) => {
      const p = parse(datasetParams, req.params, 'path');
      const query = parse(quoteQuery, req.query, 'query');
      const key = requireApiKey(req);
      return quote(
        { db: app.db.pool, buyerId: key.buyerId },
        {
          site: p.site,
          dataset: p.dataset,
          filters: query,
          sort: query.sort,
          limit: query.limit,
          cursor: query.cursor ?? null,
        },
      );
    },
  );

  app.get('/v1/:site/datasets/:dataset/records', paid, async (req, reply) => {
    const p = parse(datasetParams, req.params, 'path');
    if (!req.apiKey) return read(req, reply, { site: p.site, dataset: p.dataset, kind: 'records' });
    const query = parse(recordsQuery, req.query, 'query');
    return read(req, reply, {
      site: p.site,
      dataset: p.dataset,
      kind: 'records',
      filters: query,
      sort: query.sort,
      limit: query.limit,
      cursor: query.cursor ?? null,
      maxPriceMicros: query.max_price_micros ?? null,
    });
  });

  app.get('/v1/:site/datasets/:dataset/records/:key', paid, async (req, reply) => {
    const p = parse(recordParams, req.params, 'path');
    if (!req.apiKey) return read(req, reply, { site: p.site, dataset: p.dataset, kind: 'record' });
    const query = parse(recordQuery.strict(), req.query, 'query');
    return read(req, reply, {
      site: p.site,
      dataset: p.dataset,
      kind: 'record',
      key: p.key,
      maxPriceMicros: query.max_price_micros ?? null,
    });
  });

  app.get('/v1/:site/datasets/:dataset/changes', paid, async (req, reply) => {
    const p = parse(datasetParams, req.params, 'path');
    if (!req.apiKey) return read(req, reply, { site: p.site, dataset: p.dataset, kind: 'changes' });
    const query = parse(changesQuery.strict(), req.query, 'query');
    return read(req, reply, {
      site: p.site,
      dataset: p.dataset,
      kind: 'changes',
      cursor: query.since ?? null,
      limit: query.limit,
      includeRecord: query.include === 'record',
      maxPriceMicros: query.max_price_micros ?? null,
    });
  });

  app.get('/v1/balance', keyed, async (req) => {
    const key = requireApiKey(req);
    return balance({ db: app.db.pool }, key.buyerId);
  });
};

export default v1Routes;
