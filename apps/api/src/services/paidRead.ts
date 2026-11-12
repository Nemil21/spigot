// The paid-read pipeline (features/06 §Request pipeline; SP-017a). One function for the three
// paid endpoints, called by REST (SP-017b) and MCP (SP-022a), so quotes, price caps, 402s,
// idempotency and audit are identical on both channels:
//
//   idempotency lookup → dataset LIVE / LIVE_STALE (else 410) → query (limit clamped) →
//   serialize (visible fields only) → price = n × unit → price > max → 402 PRICE_ABOVE_MAX (no
//   row, no txn) → chargeAndRecord (one txn: CHARGE, api_calls row, audit; when short, auto
//   top-up from the saved method and retry once (SP-047a), else 402 INSUFFICIENT_BALANCE /
//   AUTO_TOPUP_CAP_REACHED / TOPUP_FAILED).
//
// The query runs before the charge so the price is exact. The unit price is read once, with the
// dataset row, and passed to `chargeAndRecord` as the snapshot: an owner's price edit while this
// call runs doesn't change what it charges.
import { createHash } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import {
  chargeAndRecord,
  type Endpoint,
  type MeterContext,
  type ServedKey,
} from '../meter/charge.js';
import {
  canonicalJson,
  autoKey,
  checkClientKey,
  REPLAYABLE,
  requestHash,
} from '../meter/idempotency.js';
import { priceMicros } from '../meter/quote.js';
import { readChanges } from '../records/changes.js';
import {
  getRecord,
  loadServedDataset,
  queryRecords,
  type ServedDataset,
} from '../records/query.js';
import {
  headers402,
  insufficientBalanceBody,
  links402,
  paymentRequiredBody,
  priceAboveMaxBody,
  type Headers402,
  type Payment402Base,
  type Quote402,
  type Site402,
} from './payment402.js';
import { loadSite402, requireSold, resolveDataset } from './lookup.js';
import type { Queryable } from '../db/pool.js';
import { autoTopupError, autoTopupHook, type AutoTopupDeps } from '../topups/autoTopup.js';
import {
  normalizeRead,
  unitPriceMicros,
  type NormalizedRead,
  type ReadKind,
  type ReadParams,
} from './quote.js';

export interface PaidReadContext extends MeterContext {
  /** `APP_BASE_URL`, for the 402 body's links. */
  baseUrl: string;
  /**
   * Test seam: runs after the query and price are fixed, before the charge (e.g. an owner price
   * edit mid-call). Never set in production code.
   */
  afterQuery?: () => Promise<void>;
  /**
   * Auto top-up on a short balance (SP-047a): the PayPal client and config. Unset → no auto
   * top-up (a short call is a plain 402). An explicit `onInsufficient` wins over this.
   */
  autoTopup?: Omit<AutoTopupDeps, 'db'>;
}

export interface PaidReadParams extends ReadParams {
  /** Per-call cap; default `buyers.per_call_max_micros`. */
  maxPriceMicros?: number | string | null;
  /** The client's `Idempotency-Key`; omitted → `autoKey` (minute bucket, SP-016). */
  idempotencyKey?: string;
  /** SP-036's simulated week (SIM buyers only; see `chargeAndRecord`). */
  simulatedAt?: Date;
}

export interface PaidReadResult {
  /** 200, or 402 (`PRICE_ABOVE_MAX`, `INSUFFICIENT_BALANCE`); a replay returns the stored status. */
  status: number;
  /** The response body; on a 200 it carries `balanceMicros` (balance after this call). */
  body: unknown;
  /** `Spigot-Call-Id`; null for `PRICE_ABOVE_MAX`, which stores no row. */
  callId: string | null;
  /** `Spigot-Charged-Micros`: charged by this request (0 on replay and 402). */
  chargedMicros: number;
  /** `Spigot-Balance-Micros`. */
  balanceMicros: number;
  /** `Spigot-Replay`. */
  replay: boolean;
  /** `Spigot-Records`: records (or changes) in the body; 0 on a 402. */
  count: number;
  /** `Link`, `Cache-Control`, `Spigot-Price` on a 402; null otherwise. */
  headers: Headers402 | null;
  /** `Spigot-Auto-Topup`: cents this call topped up from the saved PayPal method (SP-047a). */
  autoTopupCents?: number;
}

const ENDPOINT: Record<ReadKind, Endpoint> = {
  records: 'records.search',
  record: 'records.get',
  changes: 'changes.list',
};

/**
 * What gets hashed into `request_hash` (with the dataset id and endpoint, by SP-016): what the
 * client asked for, never a publisher setting, so the limit is the requested one, not the clamp.
 */
function canonicalRequest(req: NormalizedRead): unknown {
  switch (req.kind) {
    case 'records':
      return {
        filters: req.filters,
        sort: req.sort,
        limit: req.requestedLimit,
        cursor: req.cursor,
      };
    case 'record':
      return { key: req.key };
    case 'changes':
      return {
        since: req.cursor === null ? null : String(req.cursor),
        limit: req.requestedLimit,
        include: req.includeRecord ? 'record' : null,
      };
  }
}

function parseMaxPrice(raw: PaidReadParams['maxPriceMicros']): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ApiError('VALIDATION_ERROR', 'max_price_micros must be a non-negative integer.');
  }
  return n;
}

/** Records or changes in a stored body (`charged.records` / `charged.changes`). */
function countOf(body: unknown): number {
  const charged = (body as { charged?: { records?: unknown; changes?: unknown } } | null)?.charged;
  const n = charged?.records ?? charged?.changes;
  return typeof n === 'number' ? n : 0;
}

/** Adds the post-call balance to a 200 body (stored bodies don't carry it: it changes). */
function withBalance(status: number, body: unknown, balanceMicros: number): unknown {
  if (status !== 200 || !body || typeof body !== 'object') return body;
  return { ...(body as Record<string, unknown>), balanceMicros };
}

interface Served {
  body: Record<string, unknown>;
  count: number;
  servedKeys: ServedKey[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function serve(
  ctx: PaidReadContext,
  ds: ServedDataset,
  req: NormalizedRead,
  unit: number,
): Promise<Served> {
  const q = ctx.db.pool;
  if (req.kind === 'records') {
    const page = await queryRecords(q, ds, {
      filters: req.filters,
      sort: req.sort,
      limit: req.limit,
      cursor: req.cursor === null ? null : String(req.cursor),
    });
    const n = page.records.length;
    return {
      body: {
        records: page.records,
        next: page.next,
        charged: { records: n, priceMicros: priceMicros(n, unit) },
      },
      count: n,
      servedKeys: page.servedKeys,
    };
  }
  if (req.kind === 'record') {
    const found = await getRecord(q, ds, req.key!);
    // Nothing to sell: a 404, with no row and no charge.
    if (!found) throw new ApiError('NOT_FOUND', 'No such record.');
    return {
      body: { record: found.record, charged: { records: 1, priceMicros: priceMicros(1, unit) } },
      count: 1,
      servedKeys: [{ key: found.record.key, hash: found.hash }],
    };
  }
  const feed = await readChanges(q, ds, {
    since: req.cursor,
    limit: req.limit,
    includeRecord: req.includeRecord,
  });
  const n = feed.changes.length;
  return {
    body: {
      changes: feed.changes,
      next: feed.next,
      hasMore: feed.hasMore,
      charged: { changes: n, priceMicros: priceMicros(n, unit) },
    },
    count: n,
    // A change is what was sold: its hash is of the served change itself.
    servedKeys: feed.changes.map((c) => ({ key: c.key, hash: sha256(canonicalJson(c)) })),
  };
}

interface PriorCall {
  id: string;
  status: string;
  requestHash: string | null;
  httpStatus: number | null;
  responseBody: unknown;
}

export async function paidRead(
  ctx: PaidReadContext,
  params: PaidReadParams,
): Promise<PaidReadResult> {
  // One clock reading for the whole call, so the auto key we look up is the one SP-016 claims.
  const now = ctx.now?.() ?? new Date();
  const auto =
    ctx.autoTopup && !ctx.onInsufficient ? autoTopupHook({ db: ctx.db, ...ctx.autoTopup }) : null;
  const meter: MeterContext = {
    ...ctx,
    now: () => now,
    ...(auto ? { onInsufficient: auto.onInsufficient } : {}),
  };
  const q = ctx.db.pool;

  const resolved = await resolveDataset(q, params.site, params.dataset);
  const ds = await loadServedDataset(q, resolved.datasetId);
  if (!ds) throw new ApiError('NOT_FOUND', 'No such dataset.');
  const req = normalizeRead(params, ds);
  const endpoint = ENDPOINT[req.kind];
  const request = canonicalRequest(req);

  // 1. Idempotency first: a finished call replays (free) even if the dataset was unpublished since.
  const hash = requestHash({ dataset: ds.id, endpoint, request });
  const idempotencyKey =
    params.idempotencyKey !== undefined
      ? checkClientKey(params.idempotencyKey)
      : autoKey(ctx.apiKeyId, hash, now);
  const prior = await q.query<PriorCall>(
    `SELECT id, status, request_hash AS "requestHash", http_status AS "httpStatus",
            response_body AS "responseBody"
       FROM api_calls WHERE api_key_id = $1 AND idempotency_key = $2`,
    [ctx.apiKeyId, idempotencyKey],
  );
  const p = prior.rows[0];
  if (p) {
    if (p.requestHash !== hash) {
      throw new ApiError(
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (REPLAYABLE.includes(p.status)) {
      if (p.responseBody === null || p.responseBody === undefined) {
        throw new ApiError(
          'IDEMPOTENCY_KEY_EXPIRED',
          'The stored response for this Idempotency-Key has expired. Send a new key to buy again.',
        );
      }
      const balanceMicros = await buyerBalance(ctx);
      const status = p.httpStatus ?? 200;
      return {
        status,
        body: withBalance(status, p.responseBody, balanceMicros),
        callId: p.id,
        chargedMicros: 0,
        balanceMicros,
        replay: true,
        count: countOf(p.responseBody),
        headers: null,
      };
    }
    // PAYMENT_REQUIRED / REJECTED: re-attempt below; `chargeAndRecord` re-claims the same row.
  }

  // 2. Only LIVE / LIVE_STALE is sold. UNPUBLISHED → 410, no row, no charge.
  requireSold(ds.status);

  // 3–4. Query, serialize, price. `unit` is the snapshot for this call.
  const unit = unitPriceMicros(ds, req.kind);
  const served = await serve(ctx, ds, req, unit);
  const price = priceMicros(served.count, unit);
  const quote: Quote402 = {
    unit: req.kind === 'changes' ? 'changes' : 'records',
    count: served.count,
    priceMicros: price,
  };

  const buyer = await q.query<{ perCallMax: number; isSimulated: boolean }>(
    `SELECT per_call_max_micros AS "perCallMax", is_simulated AS "isSimulated" FROM buyers WHERE id = $1`,
    [ctx.buyerId],
  );
  const b = buyer.rows[0];
  if (!b) throw new ApiError('UNAUTHENTICATED', 'Unknown buyer.');

  const site: Site402 = resolved.site;
  const links = links402(ctx.baseUrl, site.slug);

  // 5. The buyer's cap: 402 with the quote, and nothing stored or posted.
  const maxPriceMicros = parseMaxPrice(params.maxPriceMicros) ?? b.perCallMax;
  if (price > maxPriceMicros) {
    return {
      status: 402,
      body: priceAboveMaxBody(site, links, { quote, maxPriceMicros }),
      callId: null,
      chargedMicros: 0,
      balanceMicros: await buyerBalance(ctx),
      replay: false,
      count: 0,
      headers: headers402(site, links),
    };
  }

  await ctx.afterQuery?.();

  // 6. One transaction: CHARGE + api_calls (channel, served keys, unit snapshot) + audit.
  const res = await chargeAndRecord(meter, {
    dataset: { id: ds.id },
    endpoint,
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    request,
    body: served.body,
    servedKeys: served.servedKeys,
    unitPriceMicros: unit,
    count: served.count,
    isSimulated: b.isSimulated,
    ...(params.simulatedAt !== undefined ? { simulatedAt: params.simulatedAt } : {}),
    paymentRequiredBody: ({ balanceMicros }) => {
      const body = insufficientBalanceBody(site, links, {
        quote,
        balanceMicros,
        channel: ctx.channel,
      });
      // Auto top-up hit the cap or was declined: say so instead of "top up".
      const error = autoTopupError(auto?.outcome() ?? null);
      return error ? { ...body, error } : body;
    },
  });
  const autoTopupCents = auto?.toppedUpCents() ?? null;

  return {
    status: res.status,
    body: withBalance(res.status, res.body, res.balanceMicros),
    callId: res.callId,
    chargedMicros: res.chargedMicros,
    balanceMicros: res.balanceMicros,
    replay: res.replay,
    count: res.status === 200 ? countOf(res.body) : 0,
    headers: res.status === 402 ? headers402(site, links) : null,
    ...(autoTopupCents !== null ? { autoTopupCents } : {}),
  };
}

async function buyerBalance(ctx: PaidReadContext): Promise<number> {
  const { rows } = await ctx.db.pool.query<{ balance: number }>(
    `SELECT balance_micros AS balance FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
    [ctx.buyerId],
  );
  return rows[0]?.balance ?? 0;
}

/**
 * An unauthenticated call to a paid endpoint (features/06 §402 shapes): `402 PAYMENT_REQUIRED`
 * with the same body and headers as the gate's (`@spigot/gate` `build402`). Unknown site or
 * dataset → 404; an unpublished dataset → 410, as for a paying buyer.
 */
export async function paymentRequired(
  deps: { db: Queryable; baseUrl: string },
  siteSlug: string,
  datasetSlug?: string,
): Promise<{ status: 402; body: Payment402Base; headers: Headers402 }> {
  let site: Site402 | null;
  if (datasetSlug !== undefined) {
    const resolved = await resolveDataset(deps.db, siteSlug, datasetSlug);
    requireSold(resolved.status);
    site = resolved.site;
  } else {
    site = await loadSite402(deps.db, siteSlug);
  }
  if (!site) throw new ApiError('NOT_FOUND', 'No such site.');
  const links = links402(deps.baseUrl, site.slug);
  return { status: 402, body: paymentRequiredBody(site, links), headers: headers402(site, links) };
}
