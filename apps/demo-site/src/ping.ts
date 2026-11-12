/**
 * The CMS side of Spigot's ping (SP-055): after a demo mutation, tell Spigot which pages changed,
 * `POST <SPIGOT_API_BASE>/api/sites/<SPIGOT_SITE_ID>/ping` with the site's crawl key
 * (`Authorization: Bearer ck_…`). Spigot re-fetches just those URLs, seconds later.
 */

/** Spigot's per-ping URL limit. */
export const MAX_PING_URLS = 500;

export interface PingConfig {
  /** Spigot API origin (`SPIGOT_API_BASE`). */
  apiBase: string;
  /** The site's id in Spigot (`SPIGOT_SITE_ID`). */
  siteId: string;
  /** The site's crawl key `ck_…` (`SPIGOT_CRAWL_KEY`). Never printed. */
  crawlKey: string;
}

export interface PingResult {
  crawlRunId: string;
  workflowRunId: string | null;
  joined: boolean;
  urls: number;
}

export class PingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PingError';
  }
}

/** Read the ping config from `env`; `PingError` naming whatever is missing. */
export function pingConfigFromEnv(env: Record<string, string | undefined>): PingConfig {
  const apiBase = env.SPIGOT_API_BASE?.trim();
  const siteId = env.SPIGOT_SITE_ID?.trim();
  const crawlKey = env.SPIGOT_CRAWL_KEY?.trim();
  const missing = [
    !apiBase && 'SPIGOT_API_BASE',
    !siteId && 'SPIGOT_SITE_ID',
    !crawlKey && 'SPIGOT_CRAWL_KEY',
  ].filter(Boolean);
  if (missing.length)
    throw new PingError(`--ping needs ${missing.join(', ')} (env or the repo .env)`);
  return { apiBase: apiBase!, siteId: siteId!, crawlKey: crawlKey! };
}

/** Absolute URLs for the changed `paths` on the site at `origin` (deduped, in order). */
export function pingUrls(origin: string, paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => new URL(p, origin).toString()))];
}

/** One ping. Throws `PingError` on any non-202 answer (with Spigot's error message). */
export async function pingSpigot(
  config: PingConfig,
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<PingResult> {
  if (urls.length === 0) throw new PingError('nothing to ping');
  if (urls.length > MAX_PING_URLS) {
    throw new PingError(
      `${urls.length} changed pages is over Spigot's ${MAX_PING_URLS}-URL ping limit; run a crawl instead`,
    );
  }
  const endpoint = new URL(`/api/sites/${encodeURIComponent(config.siteId)}/ping`, config.apiBase);
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.crawlKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<PingResult> & {
    error?: { code?: string; message?: string };
  };
  if (res.status !== 202) {
    const why = body.error ? `${body.error.code ?? ''} ${body.error.message ?? ''}`.trim() : '';
    throw new PingError(`${endpoint.origin} ping → ${res.status} ${why}`.trim(), res.status);
  }
  return {
    crawlRunId: String(body.crawlRunId),
    workflowRunId: body.workflowRunId ?? null,
    joined: body.joined === true,
    urls: Number(body.urls),
  };
}
