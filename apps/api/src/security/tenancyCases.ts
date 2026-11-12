import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TenancyCase } from './tenancy/auth.cases.js';
import type { RegisteredRoute } from './routeTable.js';

export type { TenancyCase };

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
