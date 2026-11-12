import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TenancyCase, TenantB } from './tenancy/auth.cases.js';
import type { RegisteredRoute } from './routeTable.js';

export type { TenancyCase, TenantB };

/** A case plus the `tenancy/*.cases.ts` file it came from (for failure messages). */
export interface LoadedCase extends TenancyCase {
  file: string;
}

export const CASES_DIR = fileURLToPath(new URL('./tenancy', import.meta.url));
const CASE_FILE = /\.cases\.[cm]?[jt]s$/;

/**
 * Every `tenancy/*.cases.ts` file's `cases`, glob-loaded (INDEX hot-spot rule 9: one file per
 * route ticket, never a shared list). A file without a `cases` array is an error, not a skip.
 */
export async function loadTenancyCases(dir = CASES_DIR): Promise<LoadedCase[]> {
  const files = readdirSync(dir)
    .filter((f) => CASE_FILE.test(f) && !f.endsWith('.d.ts'))
    .sort();
  const out: LoadedCase[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(`${dir}/${file}`).href)) as { cases?: unknown };
    if (!Array.isArray(mod.cases)) throw new Error(`${file} must export \`cases: TenancyCase[]\``);
    for (const c of mod.cases as TenancyCase[]) out.push({ ...c, file });
  }
  return out;
}

/** URL prefixes whose routes are tenant-scoped even without an id param (SP-042 §Scope). */
export const TENANT_PREFIXES = ['/api/publishers/me', '/api/buyer', '/api/sites', '/api/datasets'];

/**
 * True when the matrix must have a case for this route: it takes a `:param` (an id, slug or key
 * picked by the caller) or lives under one of `TENANT_PREFIXES`.
 */
export function isTenantScoped(url: string): boolean {
  if (/(^|\/):[A-Za-z_]/.test(url)) return true;
  return TENANT_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

export const routeKey = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

/** Tenant-scoped routes with no case in any file: each one fails the matrix. */
export function uncoveredRoutes(
  routes: RegisteredRoute[],
  cases: TenancyCase[],
): RegisteredRoute[] {
  const covered = new Set(cases.map(routeKey));
  return routes.filter((r) => isTenantScoped(r.url) && !covered.has(routeKey(r)));
}

/** Cases naming a route the app doesn't register (renamed or removed): stale, so they fail too. */
export function staleCases<C extends TenancyCase>(routes: RegisteredRoute[], cases: C[]): C[] {
  const registered = new Set(routes.map(routeKey));
  return cases.filter((c) => !registered.has(routeKey(c)));
}

/** Built-in: which of tenant B's ids each known `/api` and `/admin` `:param` route takes. */
const BUILT_IN_IDS: [RegExp, (b: TenantB) => string[]][] = [
  [/^\/api\/sites\/:id(\/|$)/, (b) => [b.siteId]],
  [/^\/admin\/sites\/:id(\/|$)/, (b) => [b.siteId]],
  [/^\/api\/datasets\/:id(\/|$)/, (b) => [b.liveDatasetId, b.proposedDatasetId]],
  [/^\/api\/crawl-runs\/:id(\/|$)/, (b) => [b.crawlRunId]],
  [/^\/api\/buyer\/keys\/:id(\/|$)/, (b) => [b.apiKeyId]],
  [/^\/api\/buyer\/topups\/:id(\/|$)/, (b) => [b.topupId]],
  [/^\/api\/buyer\/calls\/:id(\/|$)/, (b) => [b.callId]],
  [/^\/api\/records\/:id(\/|$)/, (b) => [b.recordId]],
];

const PARAM = /:[A-Za-z_]+/g;

/**
 * The concrete URLs to probe for a case, with tenant B's ids in its `:param` segments: the case's
 * own `ids(b)` first, then the built-in map. Public slug params (`:site`, `:dataset`, `:key`) take
 * B's public slugs. An `/api/…/:param` route with no known id **throws**: probing it with ids that
 * exist for nobody would pass whatever the route does. Only routes outside `/api` (admin routes,
 * which refuse non-admins before any lookup) fall back to a random uuid.
 */
export function tenantUrls(c: TenancyCase, b: TenantB, randomId: () => string): string[] {
  const filled = (id: string) =>
    c.url
      .replace(/:site(?=\/|$)/, b.siteSlug)
      .replace(/:dataset(?=\/|$)/, 'listings')
      .replace(/:key(?=\/|$)/, 'r-1')
      .replace(PARAM, () => id);
  const idParams = (c.url.replace(/:(site|dataset|key)(?=\/|$)/g, '').match(PARAM) ?? []).length;
  if (idParams === 0) return [filled('')];
  const ids = c.ids?.(b) ?? BUILT_IN_IDS.find(([re]) => re.test(c.url))?.[1](b);
  if (ids && ids.length > 0) return ids.map(filled);
  if (c.url.startsWith('/api/')) {
    throw new Error(
      `${routeKey(c)}: no tenant-B id for its :param; give the case \`ids: (b) => [...]\` ` +
        '(or add it to BUILT_IN_IDS in security/tenancyCases.ts)',
    );
  }
  return [filled(randomId())];
}
