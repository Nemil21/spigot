import { isErrorCode, type ErrorCode } from '@spigot/shared/errors';
import { bundledFixtures, findFixture, fixturesEnabled, type FixtureMap } from './fixtures';

/**
 * Same-origin API client (SP-024a). Every request is relative (`/api/...`) and sends the session
 * cookie; there is no CORS and no base URL. Errors arrive in the api.md envelope
 * `{ "error": { "code", "message", "details" } }` and are thrown as `ApiError`.
 *
 * Mutations take an optional `Idempotency-Key` (api.md: top-ups, payouts). The key belongs to one
 * user action, so a retry of the same action reuses it.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

/** Codes the client adds for failures that never reached the API's envelope. */
export type ClientErrorCode = 'NETWORK_ERROR' | `HTTP_${number}`;

export class ApiError extends Error {
  constructor(
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
    readonly code: ErrorCode | ClientErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    /** The full parsed body, e.g. a 402's `quote` / `pay` fields next to `error`. */
    readonly body: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Safe to retry: no response, rate limited or a 5xx. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetch?: FetchLike;
  /** Override fixture mode (tests). Defaults to `VITE_FIXTURES === "1"`. */
  fixtures?: FixtureMap | false;
}

export interface ApiClient {
  request<T>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string, opts?: Omit<RequestOptions, 'body' | 'idempotencyKey'>): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>): Promise<T>;
  delete<T>(path: string, opts?: Omit<RequestOptions, 'body'>): Promise<T>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const fixtures: FixtureMap | false =
    opts.fixtures ?? (fixturesEnabled() ? bundledFixtures : false);

  async function request<T>(method: HttpMethod, path: string, ro: RequestOptions = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error(`API paths must be same-origin and absolute: ${path}`);
    }
    if (fixtures && method === 'GET') {
      const load = findFixture(fixtures, path);
      if (load) return structuredClone(await load()) as T;
    }

    const headers: Record<string, string> = { Accept: 'application/json', ...ro.headers };
    if (ro.body !== undefined) headers['Content-Type'] = 'application/json';
    if (ro.idempotencyKey) headers['Idempotency-Key'] = ro.idempotencyKey;

    let res: Response;
    try {
      res = await doFetch(path, {
        method,
        headers,
        body: ro.body === undefined ? undefined : JSON.stringify(ro.body),
        credentials: 'same-origin',
        signal: ro.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', "We couldn't reach Spigot. Check your connection.");
    }

    const text = res.status === 204 ? '' : await res.text();
    const data: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) throw toApiError(res, data);
    return data as T;
  }

  return {
    request,
    get: (path, o) => request('GET', path, o),
    post: (path, body, o) => request('POST', path, { ...o, body }),
    put: (path, body, o) => request('PUT', path, { ...o, body }),
    patch: (path, body, o) => request('PATCH', path, { ...o, body }),
    delete: (path, o) => request('DELETE', path, o),
  };
}

function toApiError(res: Response, data: unknown): ApiError {
  const env = (data as { error?: unknown } | undefined)?.error;
  if (env && typeof env === 'object') {
    const { code, message, details } = env as Record<string, unknown>;
    return new ApiError(
      res.status,
      isErrorCode(code) ? code : `HTTP_${res.status}`,
      typeof message === 'string' ? message : res.statusText || 'Request failed',
      details && typeof details === 'object' ? (details as Record<string, unknown>) : {},
      data,
    );
  }
  return new ApiError(
    res.status,
    `HTTP_${res.status}`,
    res.statusText || 'Request failed',
    {},
    data,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The app-wide client. Screens import `api` and call `api.get('/api/...')`. */
export const api: ApiClient = createApiClient();
