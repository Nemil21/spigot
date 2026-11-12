// Zod schemas for the buyer data API `/v1` (api.md §Buyer data API; SP-017b). The routes in
// `v1.ts` parse params, query and headers with these, the integration tests check every response
// against them, and SP-023 generates `openapi.yaml` from them. Shapes follow the services in
// `services/` (SP-017a); when a service changes its output, change the schema here too.
import { z } from 'zod';
import { ERROR_CODES } from '@spigot/shared';

/** Not a route plugin: tells `@fastify/autoload` to skip this file. */
export const autoload = false;

// ── Requests ────────────────────────────────────────────────────────────────────────────────

/** A single query value: `?limit=1&limit=2` (an array) is a 400, not "the last one wins". */
const one = (what: string) =>
  z.string({ error: `${what} must be given once, as a string.` }).max(2_000);

export const siteParams = z.object({
  site: z.string().min(1).max(100).describe('Site slug, e.g. `bluebonnet`.'),
});

export const datasetParams = siteParams.extend({
  dataset: z.string().min(1).max(100).describe('Dataset slug, e.g. `listings`.'),
});

export const recordParams = datasetParams.extend({
  key: z
    .string()
    .min(1)
    .max(600)
    .describe(
      'Record key as returned in `records[].key` (`listings/…`, URL-encoded) or without the dataset prefix.',
    ),
});

/**
 * Filters are open-ended `field[op]=value` params (`bedrooms[gte]=3`, `city=Austin`,
 * `city[in]=Austin,Waco`). Only fields the dataset's schema marks `filterable` are accepted, with
 * that field's ops; anything else is `400 UNSUPPORTED_FILTER` listing the valid ones.
 */
export const FILTER_SYNTAX =
  'Filters: `field[op]=value` (op defaults to `eq`). Ops: eq, lt, lte, gt, gte, in (comma-separated, max 50). Only fields `GET /v1/{site}/datasets/{dataset}` marks filterable; `updated_at[gte]` always works.';

export const quoteQuery = z
  .looseObject({
    limit: one('limit')
      .optional()
      .describe("Records to price (default 50, max the dataset's max_records_per_call)."),
    sort: one('sort').optional().describe('`-updated_at` (default) or `updated_at`.'),
    cursor: one('cursor').optional().describe("Keyset cursor from a previous page's `next`."),
  })
  .describe(FILTER_SYNTAX);

export const maxPriceMicros = one('max_price_micros')
  .regex(/^\d+$/, 'max_price_micros must be a non-negative integer.')
  .optional()
  .describe(
    "Per-call price cap in micros; default your account's per-call max. Above it → 402 PRICE_ABOVE_MAX, no charge.",
  );

export const recordsQuery = quoteQuery.extend({ max_price_micros: maxPriceMicros });

export const recordQuery = z.object({ max_price_micros: maxPriceMicros });

export const changesQuery = z.object({
  since: one('since')
    .optional()
    .describe(
      'Cursor from a previous `next`. Omitted → start at the watermark (free, returns a cursor). `0` → full history.',
    ),
  limit: one('limit').optional().describe('Changes to return (default 200, max 1,000).'),
  include: z
    .enum(['record'])
    .optional()
    .describe('`record` adds the current record to each change (no extra charge).'),
  max_price_micros: maxPriceMicros,
});

/** `Idempotency-Key` (optional): without it, retries are deduplicated within the same minute only. */
export const idempotencyKeyHeader = z
  .string({ error: 'Idempotency-Key must be sent once.' })
  .min(1, 'Idempotency-Key must not be empty.')
  .max(255, 'Idempotency-Key must be at most 255 characters.')
  .optional();

// ── Responses ───────────────────────────────────────────────────────────────────────────────

const isoOrNull = z.string().nullable();
const micros = z.number().int().nonnegative();

export const errorEnvelope = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const catalogResponse = z.object({
  sites: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      datasets: z.array(
        z.object({
          slug: z.string(),
          type: z.string(),
          records: z.number().int(),
          perRecordMicros: micros,
          perChangeMicros: micros,
          freshness: z.object({ lastCrawlAt: isoOrNull, staleSince: isoOrNull }),
        }),
      ),
    }),
  ),
});

export const describeResponse = z.object({
  type: z.string(),
  version: z.number().int().nullable(),
  records: z.number().int(),
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
      filterable: z.array(z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'in'])),
    }),
  ),
  pricing: z.object({ perRecordMicros: micros, perChangeMicros: micros, display: z.string() }),
  maxRecordsPerCall: z.number().int(),
  freshness: z.object({ lastCrawlAt: isoOrNull, staleSince: isoOrNull }),
  license: z.string(),
});

export const quoteResponse = z.object({
  records: z.number().int().nonnegative(),
  unitPriceMicros: micros,
  priceMicros: micros,
  display: z.string(),
  balanceMicros: z.number().int(),
  wouldAutoTopUp: z.boolean(),
  validForSeconds: z.number().int(),
});

export const servedRecord = z.object({
  key: z.string(),
  data: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  freshness: z.object({ crawledAt: isoOrNull, sourceLastmod: isoOrNull, staleSince: isoOrNull }),
});

export const recordsResponse = z.object({
  records: z.array(servedRecord),
  next: z.string().nullable(),
  charged: z.object({ records: z.number().int(), priceMicros: micros }),
  balanceMicros: z.number().int(),
});

export const recordResponse = z.object({
  record: servedRecord,
  charged: z.object({ records: z.literal(1), priceMicros: micros }),
  balanceMicros: z.number().int(),
});

export const changesResponse = z.object({
  changes: z.array(
    z.object({
      cursor: z.string(),
      key: z.string(),
      op: z.enum(['add', 'update', 'remove']),
      version: z.number().int(),
      patch: z.array(z.record(z.string(), z.unknown())),
      changedAt: z.string(),
      record: servedRecord.nullable().optional(),
    }),
  ),
  next: z.string(),
  hasMore: z.boolean(),
  charged: z.object({ changes: z.number().int(), priceMicros: micros }),
  balanceMicros: z.number().int(),
});

export const balanceResponse = z.object({
  balanceMicros: z.number().int(),
  autoTopup: z.object({
    enabled: z.boolean(),
    thresholdMicros: micros,
    amountCents: z.number().int(),
    remainingThisMonthCents: z.number().int(),
    hasSavedMethod: z.boolean(),
  }),
});

/** `POST /v1/topups` and MCP `top_up` (`services/agentTopUp.ts`; documented by SP-023). */
export const topupResponse = z.object({
  topupId: z.string(),
  status: z
    .string()
    .describe('`AWAITING_APPROVAL` for a new link; a replay returns the final status.'),
  amountCents: z.number().int(),
  orderId: z.string().nullable().describe('The PayPal order id.'),
  approveUrl: z
    .string()
    .nullable()
    .describe('PayPal approval link for a human to open; `null` once the top-up has finished.'),
  balanceMicros: z.number().int().optional().describe('Your balance, once `COMPLETED`.'),
});

/** The 402 body shared with the gate (api.md §The 402 contract). */
export const payment402Body = z.object({
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }),
  site: z.string(),
  datasets: z.array(
    z.object({
      slug: z.string(),
      type: z.string(),
      records: z.number().int(),
      perRecordMicros: micros,
      endpoint: z.string(),
    }),
  ),
  pay: z.object({
    method: z.literal('prepaid_balance'),
    provider: z.literal('PayPal'),
    topUpUrl: z.string(),
    mcp: z.string(),
  }),
  terms: z.string(),
});

const quote402 = z.object({
  records: z.number().int().optional(),
  changes: z.number().int().optional(),
  priceMicros: micros,
});

export const insufficientBalance402Body = payment402Body.extend({
  quote: quote402,
  balanceMicros: z.number().int(),
  topUpUrl: z.string(),
});

export const priceAboveMax402Body = payment402Body.extend({
  quote: quote402,
  maxPriceMicros: micros,
});

/** Response headers on every paid 2xx (documented by SP-023). */
export const PAID_RESPONSE_HEADERS = {
  'Spigot-Charged-Micros': 'Micros charged by this request (0 on a replay or zero results).',
  'Spigot-Balance-Micros': 'Your balance after this request.',
  'Spigot-Records': 'Records (or changes) in the body.',
  'Spigot-Call-Id': 'The call id (use it for claims).',
  'Spigot-Replay': '`true` when this is a stored response replayed for the same Idempotency-Key.',
} as const;

/** Headers on every 402 (same as the gate's). */
export const PAYMENT_402_HEADERS = {
  Link: 'The dataset (`rel="alternate"`) and the public catalog page (`rel="payment"`).',
  'Spigot-Price': '`<dataset>; per-record-micros=<n>` for each dataset the site sells.',
  'Cache-Control': '`no-store`.',
} as const;
