/**
 * `@spigot/sdk`: a typed client for Spigot's buyer `/v1` API (`openapi.yaml`). Zero runtime
 * dependencies (global `fetch`, Node 18+ or any browser).
 *
 *   const spigot = new SpigotClient({ apiKey: process.env.SPIGOT_KEY });
 *   const { records, charged } = await spigot.records.search('bluebonnet', 'listings', { 'bedrooms[gte]': 3 });
 *
 * Non-2xx responses throw `SpigotError` with the API's error `code`; a 402 carries `topUpUrl`.
 */
import type {
  Balance,
  CallMeta,
  Catalog,
  ChangesPage,
  Claim,
  ClaimRequest,
  DatasetDescription,
  ErrorBody,
  Filters,
  Quote,
  RecordResult,
  RecordsPage,
  Topup,
} from './types.js';

export type * from './types.js';

export const DEFAULT_BASE_URL = 'https://spigot.onrender.com';

export interface SpigotClientOptions {
  /** `sk_spg_…`. Optional: the catalog and dataset descriptions are free; paid calls without a key get a 402. */
  apiKey?: string | undefined;
  /** Defaults to the hosted API. */
  baseUrl?: string | undefined;
  /** Bring your own fetch (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface PageOptions {
  limit?: number;
  /** `-updated_at` (default) or `updated_at`. */
  sort?: '-updated_at' | 'updated_at';
  /** The previous page's `next`. */
  cursor?: string | null;
}

export interface PaidOptions {
  /** Refuse (402 `PRICE_ABOVE_MAX`, no charge) if the call would cost more than this. */
  maxPriceMicros?: number;
  /** Same key + same request → the stored response is replayed and never charged twice. */
  idempotencyKey?: string;
}

export interface ChangesOptions extends PaidOptions {
  /** A previous `next`. Omitted → start at the watermark (free); `'0'` → full history. */
  since?: string | null;
  limit?: number;
  /** Add the current record to each change (no extra charge). */
  includeRecord?: boolean;
}

/** A non-2xx response from the API. */
export class SpigotError extends Error {
  override readonly name = 'SpigotError';
  /** The API error code, e.g. `INSUFFICIENT_BALANCE`, `UNSUPPORTED_FILTER`. */
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** Where to top up (402s). */
  readonly topUpUrl: string | undefined;

  constructor(
    readonly status: number,
    readonly body: ErrorBody,
    readonly headers: Headers,
  ) {
    super(body.error?.message ?? `HTTP ${status}`);
    this.code = body.error?.code ?? `HTTP_${status}`;
    this.details = body.error?.details;
    const pay = body.pay as { topUpUrl?: string } | undefined;
    this.topUpUrl = body.topUpUrl ?? pay?.topUpUrl;
  }
}

type Query = Record<
  string,
  string | number | boolean | readonly (string | number)[] | null | undefined
>;

export class SpigotClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: SpigotClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = options.apiKey || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** What is for sale (free). */
  readonly catalog = {
    list: (): Promise<Catalog> => this.#json('GET', '/v1/catalog'),
  };

  readonly datasets = {
    /** Fields (and which filter ops each takes), pricing and freshness (free). */
    describe: (site: string, dataset: string): Promise<DatasetDescription> =>
      this.#json('GET', `${datasetPath(site, dataset)}`),
  };

  readonly records = {
    /** Price a query without running it (free; needs a key). */
    quote: (
      site: string,
      dataset: string,
      filters: Filters = {},
      opts: PageOptions = {},
    ): Promise<Quote> =>
      this.#json('GET', `${datasetPath(site, dataset)}/quote`, {
        query: { ...filters, ...pageQuery(opts) },
      }),

    /** Search records; charges `records × perRecordMicros` (zero results cost nothing). */
    search: <T = Record<string, unknown>>(
      site: string,
      dataset: string,
      filters: Filters = {},
      opts: PageOptions & PaidOptions = {},
    ): Promise<RecordsPage<T>> =>
      this.#paid('GET', `${datasetPath(site, dataset)}/records`, opts, {
        ...filters,
        ...pageQuery(opts),
      }),

    /** One record by key (charged as one record). */
    get: <T = Record<string, unknown>>(
      site: string,
      dataset: string,
      key: string,
      opts: PaidOptions = {},
    ): Promise<RecordResult<T>> =>
      this.#paid('GET', `${datasetPath(site, dataset)}/records/${encodeURIComponent(key)}`, opts),
  };

  readonly changes = {
    /** The change feed; charges `changes × perChangeMicros`. */
    list: <T = Record<string, unknown>>(
      site: string,
      dataset: string,
      opts: ChangesOptions = {},
    ): Promise<ChangesPage<T>> =>
      this.#paid('GET', `${datasetPath(site, dataset)}/changes`, opts, {
        since: opts.since,
        limit: opts.limit,
        include: opts.includeRecord ? 'record' : undefined,
      }),
  };

  readonly balance = {
    get: (): Promise<Balance> => this.#json('GET', '/v1/balance'),
  };

  readonly topups = {
    /** Start a PayPal top-up of `amountCents` (500–50,000); open `approveUrl` to approve. */
    create: (amountCents: number, opts: { idempotencyKey?: string } = {}): Promise<Topup> =>
      this.#json('POST', '/v1/topups', {
        body: { amountCents },
        headers: idempotencyHeader(opts.idempotencyKey),
      }),
  };

  readonly claims = {
    /** Report a bad record from a paid call (`callId` from that call's result). */
    create: (claim: ClaimRequest): Promise<Claim> =>
      this.#json('POST', '/v1/claims', { body: claim }),
  };

  async #paid<T>(
    method: string,
    path: string,
    opts: PaidOptions,
    query: Query = {},
  ): Promise<T & CallMeta> {
    const { body, headers } = await this.#request<T>(method, path, {
      query: { ...query, max_price_micros: opts.maxPriceMicros },
      headers: idempotencyHeader(opts.idempotencyKey),
    });
    return {
      ...body,
      callId: headers.get('spigot-call-id'),
      replay: headers.get('spigot-replay') === 'true',
    };
  }

  async #json<T>(
    method: string,
    path: string,
    init: { query?: Query; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return (await this.#request<T>(method, path, init)).body;
  }

  async #request<T>(
    method: string,
    path: string,
    init: { query?: Query; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ body: T; headers: Headers }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: { code: `HTTP_${res.status}`, message: text.slice(0, 500) } };
    }
    if (!res.ok) throw new SpigotError(res.status, parsed as ErrorBody, res.headers);
    return { body: parsed as T, headers: res.headers };
  }
}

function datasetPath(site: string, dataset: string): string {
  return `/v1/${encodeURIComponent(site)}/datasets/${encodeURIComponent(dataset)}`;
}

function pageQuery(opts: PageOptions): Query {
  return { limit: opts.limit, sort: opts.sort, cursor: opts.cursor };
}

function idempotencyHeader(key: string | undefined): Record<string, string> {
  return key ? { 'idempotency-key': key } : {};
}
