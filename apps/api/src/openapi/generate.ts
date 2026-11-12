// OpenAPI 3.1 for the buyer data API `/v1` (features/11 §Logic 9; api.md intro; SP-023), built with
// `@asteasolutions/zod-to-openapi` from the same Zod schemas the routes parse with
// (`routes/v1.schemas.ts`, `routes/v1-topups.ts`). The committed root `openapi.yaml` is this
// document with the default server; `npm run openapi` rewrites it, and `generate.test.ts` fails CI
// when it is stale or when a `/v1` route is registered without an entry here. APIMatic (SP-056)
// imports the committed file. `GET /v1/openapi.yaml` serves it with `servers` set to the
// deployment's `APP_BASE_URL`.
//
// Adding a `/v1` route: register it in `registerPaths` below, then `npm run openapi`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '@spigot/shared';
import { topupRequestBody } from '../routes/v1-topups.js';
import {
  FILTER_SYNTAX,
  PAID_RESPONSE_HEADERS,
  PAYMENT_402_HEADERS,
  balanceResponse,
  catalogResponse,
  changesQuery,
  changesResponse,
  datasetParams,
  describeResponse,
  errorEnvelope,
  idempotencyKeyHeader,
  insufficientBalance402Body,
  payment402Body,
  priceAboveMax402Body,
  quoteQuery,
  quoteResponse,
  recordParams,
  recordQuery,
  recordResponse,
  recordsQuery,
  recordsResponse,
  topupResponse,
} from '../routes/v1.schemas.js';

// `.meta({ id })` makes a named copy that the generator emits once under
// `#/components/schemas/<id>` and `$ref`s wherever it is used.
const S = {
  ErrorEnvelope: errorEnvelope.meta({ id: 'ErrorEnvelope' }),
  Catalog: catalogResponse.meta({ id: 'Catalog' }),
  DatasetDescription: describeResponse.meta({ id: 'DatasetDescription' }),
  Quote: quoteResponse.meta({ id: 'Quote' }),
  RecordsPage: recordsResponse.meta({ id: 'RecordsPage' }),
  RecordResult: recordResponse.meta({ id: 'RecordResult' }),
  ChangesPage: changesResponse.meta({ id: 'ChangesPage' }),
  Balance: balanceResponse.meta({ id: 'Balance' }),
  PaymentRequired: payment402Body.meta({ id: 'PaymentRequired' }),
  InsufficientBalance: insufficientBalance402Body.meta({ id: 'InsufficientBalance' }),
  PriceAboveMax: priceAboveMax402Body.meta({ id: 'PriceAboveMax' }),
  TopupRequest: topupRequestBody.meta({ id: 'TopupRequest' }),
  Topup: topupResponse.meta({ id: 'Topup' }),
};

/** The committed file's server; the served copy uses `APP_BASE_URL` instead. */
export const DEFAULT_SERVER_URL = 'https://spigot.onrender.com';

/** Root `openapi.yaml` (four levels up from `apps/api/src/openapi/`). */
export const OPENAPI_YAML_PATH = fileURLToPath(
  new URL('../../../../openapi.yaml', import.meta.url),
);

/** Every `/v1` route the document describes, as `METHOD /path` with Fastify `:param` syntax. */
export const DOCUMENTED_ROUTES = [
  'GET /v1/catalog',
  'GET /v1/openapi.yaml',
  'GET /v1/:site/datasets/:dataset',
  'GET /v1/:site/datasets/:dataset/quote',
  'GET /v1/:site/datasets/:dataset/records',
  'GET /v1/:site/datasets/:dataset/records/:key',
  'GET /v1/:site/datasets/:dataset/changes',
  'GET /v1/balance',
  'POST /v1/topups',
] as const;

const IDEMPOTENCY =
  'Makes a retry safe: the same key and the same request replay the stored response (`Spigot-Replay: true`) and never charge twice; the same key with a different request is `409 IDEMPOTENCY_MISMATCH`. Keys are scoped to your API key. **Without this header, retries are deduplicated only within the same minute** (the server derives a key from the request and the current minute), so a retry that crosses a minute boundary is a new call. Send the header for exact retry safety.';

const DESCRIPTION = `Spigot's buyer data API: structured records from publisher sites, paid per record from a prepaid balance (topped up with PayPal).

**Auth.** \`Authorization: Bearer sk_spg_…\` (create keys in the buyer portal; scopes \`read\`, \`topup\`). \`GET /v1/catalog\`, \`GET /v1/{site}/datasets/{dataset}\` and this document are free and need no key. Calling a paid route **without a key** returns \`402 PAYMENT_REQUIRED\` with the catalog and how to pay (not 401); a malformed, unknown or revoked key is \`401\`.

**Money.** Prices and balances are integer **micros** of USD (\`1500\` = $0.0015); top-up amounts are **cents**.

**Filters.** ${FILTER_SYNTAX} Unknown fields or ops → \`400 UNSUPPORTED_FILTER\` listing the valid ones.

**Idempotency.** Paid reads and \`POST /v1/topups\` take an optional \`Idempotency-Key\` header. ${IDEMPOTENCY}

**Rate limits.** 60 calls/min per API key (keyless calls to paid routes: per client IP) → \`429 RATE_LIMITED\` with \`Retry-After\`.

**Errors.** \`{ "error": { "code", "message", "details"? } }\`. A 402 adds the payment fields (\`site\`, \`datasets\`, \`pay\`, \`terms\`, and the quote).`;

// ── Error responses ─────────────────────────────────────────────────────────────────────────

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

function codesFor(status: number, only?: readonly ErrorCode[]): ErrorCode[] {
  const all = (Object.keys(ERROR_STATUS) as ErrorCode[]).filter((c) => ERROR_STATUS[c] === status);
  return only ? all.filter((c) => only.includes(c)) : all;
}

/** An error-envelope response whose description lists the codes this route can return. */
function error(status: number, what: string, only?: readonly ErrorCode[]): ResponseConfig {
  const codes = codesFor(status, only);
  if (codes.length === 0) throw new Error(`openapi: no error code with status ${status}`);
  return {
    description: `${what} Codes: ${codes.map((c) => `\`${c}\``).join(', ')}.`,
    content: json(S.ErrorEnvelope),
  };
}

/**
 * Response headers from `{ name: description }`. `types` overrides a header's schema (default a
 * required string); make a header `.optional()` when it is not on every response.
 */
const headers = (h: Record<string, string>, types: Record<string, z.ZodType> = {}) =>
  z.object(
    Object.fromEntries(
      Object.entries(h).map(([k, d]) => [k, (types[k] ?? z.string()).describe(d)]),
    ),
  );

const int = z.int();

const RATE_LIMIT_HEADERS = {
  'RateLimit-Limit': 'Calls allowed per minute for this key (or IP).',
  'RateLimit-Remaining': 'Calls left in the current window.',
} as const;

const rateLimited: ResponseConfig = {
  ...error(429, 'Over the per-minute limit; retry after `Retry-After` seconds.'),
  headers: headers(
    { ...RATE_LIMIT_HEADERS, 'Retry-After': 'Seconds to wait.' },
    { 'RateLimit-Limit': int, 'RateLimit-Remaining': int, 'Retry-After': int },
  ),
};

const unauthenticated = error(401, 'Missing, malformed, unknown or revoked API key.');
const forbidden = (scope: string) =>
  error(403, `The API key lacks the \`${scope}\` scope.`, ['FORBIDDEN']);
const badRequest = (only?: readonly ErrorCode[]) =>
  error(400, 'Invalid path, query, header or body.', only);
const notFound = error(404, 'Unknown site or dataset (or record), or a dataset not published.');
const gone = (only: readonly ErrorCode[]) =>
  error(
    410,
    'The dataset was unpublished, or the cursor is older than the retained history.',
    only,
  );

const payment402 = (paid: boolean): ResponseConfig => ({
  description: paid
    ? 'Payment needed; nothing was charged. `PAYMENT_REQUIRED`: no API key sent (the body lists the datasets and how to pay). `INSUFFICIENT_BALANCE`: the call costs more than your balance (body has the quote and `topUpUrl`). `PRICE_ABOVE_MAX`: the call costs more than `max_price_micros` (body has the quote).'
    : 'No API key sent.',
  headers: headers(PAYMENT_402_HEADERS, { 'Spigot-Price': z.string().optional() }),
  content: json(
    paid ? z.union([S.InsufficientBalance, S.PriceAboveMax, S.PaymentRequired]) : S.PaymentRequired,
  ),
});

const paidHeaders = headers(PAID_RESPONSE_HEADERS, {
  'Spigot-Charged-Micros': int,
  'Spigot-Balance-Micros': int,
  'Spigot-Records': int,
  'Spigot-Call-Id': z.string().optional(),
  'Spigot-Replay': z.enum(['true']).optional(),
});

// ── Paths ───────────────────────────────────────────────────────────────────────────────────

const BEARER = 'bearerAuth';
const keyed: Record<string, string[]>[] = [{ [BEARER]: [] }];
/** Paid routes: a key is required to read; with none, the 402 tells the caller how to pay. */
const keyedOrPaymentRequired: Record<string, string[]>[] = [{ [BEARER]: [] }, {}];

const idempotencyHeaders = z.object({
  'Idempotency-Key': idempotencyKeyHeader.describe(IDEMPOTENCY),
});

/** The open-ended `field[op]=value` filters (a free-form, exploded query object). */
const filtersParam = {
  name: 'filters',
  in: 'query' as const,
  required: false,
  style: 'form' as const,
  explode: true,
  description: `${FILTER_SYNTAX} Example: \`bedrooms[gte]=3&price_usd[lt]=2000&city=Austin\`.`,
  schema: { type: 'object' as const, additionalProperties: { type: 'string' as const } },
  example: { 'bedrooms[gte]': '3', 'price_usd[lt]': '2000', city: 'Austin' },
};

/** Fastify `:param` → OpenAPI `{param}`. */
const oas = (path: string) => path.replace(/:(\w+)/g, '{$1}');

/**
 * Drop the open-ended `.catchall`/`looseObject` part (documented by `filtersParam`): the
 * generator only reads named properties for query parameters.
 */
const named = <T extends z.ZodObject>(schema: T) => z.object(schema.shape);

function registerPaths(r: OpenAPIRegistry): void {
  r.registerPath({
    method: 'get',
    path: '/v1/catalog',
    operationId: 'getCatalog',
    tags: ['Catalog'],
    summary: 'List sites and their published datasets (free)',
    security: [],
    responses: { 200: { description: 'The catalog.', content: json(S.Catalog) } },
  });

  r.registerPath({
    method: 'get',
    path: '/v1/openapi.yaml',
    operationId: 'getOpenApi',
    tags: ['Catalog'],
    summary: 'This OpenAPI document (free)',
    security: [],
    responses: {
      200: {
        description: 'OpenAPI 3.1 document for `/v1`.',
        content: { 'application/yaml': { schema: { type: 'string' } } },
      },
    },
  });

  r.registerPath({
    method: 'get',
    path: oas('/v1/:site/datasets/:dataset'),
    operationId: 'describeDataset',
    tags: ['Catalog'],
    summary: 'Dataset schema, filterable fields and ops, pricing (free)',
    security: [],
    request: { params: datasetParams },
    responses: {
      200: { description: 'The dataset description.', content: json(S.DatasetDescription) },
      400: badRequest(['VALIDATION_ERROR']),
      404: notFound,
      410: gone(['DATASET_UNPUBLISHED']),
    },
  });

  r.registerPath({
    method: 'get',
    path: oas('/v1/:site/datasets/:dataset/quote'),
    operationId: 'quoteRecords',
    tags: ['Records'],
    summary: 'Price a records query without running it (free)',
    description:
      'Counts the records the same query would return (capped at `limit`) and prices them. Takes the same filters as `records`. Nothing is charged.',
    security: keyed,
    request: { params: datasetParams, query: named(quoteQuery) },
    parameters: [filtersParam],
    responses: {
      200: { description: 'The quote.', content: json(S.Quote) },
      400: badRequest(['VALIDATION_ERROR', 'UNSUPPORTED_FILTER']),
      401: unauthenticated,
      403: forbidden('read'),
      404: notFound,
      410: gone(['DATASET_UNPUBLISHED', 'CURSOR_EXPIRED']),
      429: rateLimited,
    },
  });

  const paidErrors = (extra400: ErrorCode[] = []) => ({
    400: badRequest(['VALIDATION_ERROR', ...extra400]),
    401: unauthenticated,
    402: payment402(true),
    403: forbidden('read'),
    404: notFound,
    409: error(
      409,
      'The `Idempotency-Key` was used with a different request, or its stored response has expired (24 h; never re-charged).',
      ['IDEMPOTENCY_MISMATCH', 'IDEMPOTENCY_KEY_EXPIRED'],
    ),
    410: gone(['DATASET_UNPUBLISHED', 'CURSOR_EXPIRED']),
    429: rateLimited,
  });

  r.registerPath({
    method: 'get',
    path: oas('/v1/:site/datasets/:dataset/records'),
    operationId: 'searchRecords',
    tags: ['Records'],
    summary: 'Search records (paid per record)',
    description:
      'Charges `records × perRecordMicros` from your balance on success; zero results cost nothing. Pages with `cursor` (keyset; pass the previous `next`).',
    security: keyedOrPaymentRequired,
    request: { params: datasetParams, query: named(recordsQuery), headers: idempotencyHeaders },
    parameters: [filtersParam],
    responses: {
      200: { description: 'The records.', headers: paidHeaders, content: json(S.RecordsPage) },
      ...paidErrors(['UNSUPPORTED_FILTER']),
    },
  });

  r.registerPath({
    method: 'get',
    path: oas('/v1/:site/datasets/:dataset/records/:key'),
    operationId: 'getRecord',
    tags: ['Records'],
    summary: 'One record by key (paid, 1 record)',
    security: keyedOrPaymentRequired,
    request: { params: recordParams, query: recordQuery, headers: idempotencyHeaders },
    responses: {
      200: { description: 'The record.', headers: paidHeaders, content: json(S.RecordResult) },
      ...paidErrors(),
    },
  });

  r.registerPath({
    method: 'get',
    path: oas('/v1/:site/datasets/:dataset/changes'),
    operationId: 'getChanges',
    tags: ['Changes'],
    summary: 'Changes feed since a cursor (paid per change)',
    description:
      'JSON Patch per changed record, oldest first. Without `since`, returns no changes and a starting cursor (free). `since=0` is the full history. `include=record` adds the current record at no extra charge.',
    security: keyedOrPaymentRequired,
    request: { params: datasetParams, query: changesQuery, headers: idempotencyHeaders },
    responses: {
      200: { description: 'The changes.', headers: paidHeaders, content: json(S.ChangesPage) },
      ...paidErrors(),
    },
  });

  r.registerPath({
    method: 'get',
    path: '/v1/balance',
    operationId: 'getBalance',
    tags: ['Balance'],
    summary: 'Your balance and auto top-up settings',
    security: keyed,
    responses: {
      200: { description: 'The balance.', content: json(S.Balance) },
      401: unauthenticated,
      429: rateLimited,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/v1/topups',
    operationId: 'createTopup',
    tags: ['Balance'],
    summary: 'Start a PayPal top-up (returns an approval link)',
    description:
      'Creates a PayPal order for `amountCents` and returns `approveUrl` for a human to open; PayPal returns them to Spigot, which captures and credits the balance once. Replaying the same request (same `Idempotency-Key`) returns the same top-up, with its final status once finished (`COMPLETED` adds `balanceMicros`). Needs the `topup` scope.',
    security: keyed,
    request: {
      headers: idempotencyHeaders,
      body: { required: true, content: json(S.TopupRequest) },
    },
    responses: {
      200: { description: 'The top-up.', content: json(S.Topup) },
      400: badRequest(['VALIDATION_ERROR']),
      401: unauthenticated,
      403: forbidden('topup'),
      409: error(409, 'The `Idempotency-Key` was used with a different request.', [
        'IDEMPOTENCY_MISMATCH',
      ]),
      422: error(422, 'PayPal refused the order.', ['TOPUP_FAILED']),
      429: rateLimited,
      502: error(502, 'PayPal could not be reached.', ['PAYPAL_ERROR']),
    },
  });
}

// ── Document ────────────────────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** The API's origin (no trailing slash); paths already start with `/v1`. */
  serverUrl?: string;
}

/** The OpenAPI 3.1 document as a plain object. */
export function generateOpenApi(opts: GenerateOptions = {}): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', BEARER, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'sk_spg_…',
    description: 'A buyer API key from the buyer portal.',
  });
  registerPaths(registry);

  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Spigot data API',
      version: '1.0.0',
      description: DESCRIPTION,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: (opts.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '') }],
    security: keyed,
    tags: [
      { name: 'Catalog', description: 'What is for sale (free).' },
      { name: 'Records', description: 'Paid record reads.' },
      { name: 'Changes', description: 'Paid changes feed.' },
      { name: 'Balance', description: 'Prepaid balance and PayPal top-ups.' },
    ],
  });
  return doc as unknown as Record<string, unknown>;
}

const HEADER =
  '# Generated by `npm run openapi` from apps/api/src/openapi/generate.ts. Do not edit.\n';

/** The document as YAML (stable output: the committed file must equal a fresh render). */
export function renderOpenApiYaml(opts: GenerateOptions = {}): string {
  return HEADER + stringify(generateOpenApi(opts), { lineWidth: 0, aliasDuplicateObjects: false });
}

// `npm run openapi`: rewrite the committed root openapi.yaml.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OPENAPI_YAML_PATH, renderOpenApiYaml());
  console.log(`openapi: wrote ${OPENAPI_YAML_PATH}`);
}
