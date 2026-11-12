// Template clustering (features/04 §1). Pure: no Node-only APIs, so apps/web can import it.
//
// Pages are grouped by URL path shape: a path segment whose value varies across at least
// `paramMinDistinct` pages with slug/number shapes becomes a `:param`. Each group is then split
// by its JSON-LD `@type` set, small groups are dropped, and 5 sample pages are picked with a
// seeded shuffle so the same input always yields the same samples.

export interface ClusterPage {
  id: string;
  url: string;
}

export interface Template {
  /** Display pattern, e.g. `/listings/:slug`. */
  pathPattern: string;
  /** Anchored regex stored in `templates.url_pattern`, e.g. `^/listings/[a-z0-9-]+$`. */
  urlPattern: string;
  /** Sorted, de-duplicated JSON-LD `@type` values shared by every page in the template. */
  jsonldTypes: string[];
  pageCount: number;
  /** Ids of every page in the template, sorted. */
  pageIds: string[];
  /** Up to `sampleSize` page ids, deterministic for the same input and seed. */
  samplePageIds: string[];
}

export interface ClusterOptions {
  /** Distinct slug/number values a segment needs before it becomes a `:param`. */
  paramMinDistinct?: number;
  /** Groups with fewer pages are dropped. */
  minPages?: number;
  sampleSize?: number;
  seed?: string;
}

export const CLUSTER_DEFAULTS = {
  paramMinDistinct: 20,
  minPages: 10,
  sampleSize: 5,
  seed: 'spigot',
} as const satisfies Required<ClusterOptions>;

export type JsonLdTypesByUrl =
  ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>;

const SLUG_RE = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/;
const ID_RES = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[A-Za-z]{1,4}[-_]?\d+$/, // short prefix + number, e.g. `oh-12`
];

const isSlugOrNumber = (s: string) => SLUG_RE.test(s);
const isId = (s: string) => ID_RES.some((re) => re.test(s));

/** Path of a URL (or bare path) without query, fragment or trailing slash; `/` for the root. */
export function urlPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://x.invalid').pathname;
  } catch {
    return null;
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

type Seg = { kind: 'lit'; value: string } | { kind: 'param' };
type Entry = { page: ClusterPage; segs: string[] };

export function clusterUrls(
  pages: readonly (ClusterPage | string)[],
  jsonLdTypesByUrl: JsonLdTypesByUrl = {},
  options: ClusterOptions = {},
): Template[] {
  const opts = { ...CLUSTER_DEFAULTS, ...options };
  const typesOf = (url: string): readonly string[] =>
    (jsonLdTypesByUrl instanceof Map
      ? jsonLdTypesByUrl.get(url)
      : (jsonLdTypesByUrl as Record<string, readonly string[]>)[url]) ?? [];

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const page = typeof p === 'string' ? { id: p, url: p } : p;
    if (seen.has(page.id)) continue;
    const path = urlPath(page.url);
    if (path === null) continue;
    seen.add(page.id);
    entries.push({ page, segs: path.split('/').filter(Boolean) });
  }

  const groups: { segs: Seg[]; entries: Entry[] }[] = [];
  const walk = (items: Entry[], depth: number, prefix: Seg[]) => {
    const here = items.filter((e) => e.segs.length === depth);
    if (here.length) groups.push({ segs: prefix, entries: here });

    const byValue = new Map<string, Entry[]>();
    for (const e of items) {
      if (e.segs.length <= depth) continue;
      const v = e.segs[depth]!;
      const bucket = byValue.get(v);
      if (bucket) bucket.push(e);
      else byValue.set(v, [e]);
    }
    const paramValues = [...byValue.keys()].filter(isSlugOrNumber);
    const asParam =
      paramValues.length >= opts.paramMinDistinct ? new Set(paramValues) : new Set<string>();

    if (asParam.size) {
      const merged = [...asParam].flatMap((v) => byValue.get(v)!);
      walk(merged, depth + 1, [...prefix, { kind: 'param' }]);
    }
    for (const [v, es] of [...byValue].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!asParam.has(v)) walk(es, depth + 1, [...prefix, { kind: 'lit', value: v }]);
    }
  };
  walk(entries, 0, []);

  const templates: Template[] = [];
  for (const g of groups) {
    const { pathPattern, urlPattern } = patternsFor(g.segs, g.entries);
    const byTypes = new Map<string, { types: string[]; entries: Entry[] }>();
    for (const e of g.entries) {
      const types = [...new Set(typesOf(e.page.url))].sort();
      const key = JSON.stringify(types);
      const bucket = byTypes.get(key) ?? { types, entries: [] };
      bucket.entries.push(e);
      byTypes.set(key, bucket);
    }
    for (const { types, entries: es } of byTypes.values()) {
      if (es.length < opts.minPages) continue;
      const pageIds = es.map((e) => e.page.id).sort();
      templates.push({
        pathPattern,
        urlPattern,
        jsonldTypes: types,
        pageCount: pageIds.length,
        pageIds,
        samplePageIds: seededSample(
          pageIds,
          opts.sampleSize,
          `${opts.seed}|${urlPattern}|${types.join(',')}`,
        ),
      });
    }
  }

  const key = (t: Template) => `${t.urlPattern}\u0000${t.jsonldTypes.join(',')}`;
  return templates.sort(
    (a, b) => b.pageCount - a.pageCount || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
  );
}

/**
 * Patterns from the values this group's pages actually hold, so a slug-shaped literal sibling
 * (`/shop/all` next to `/shop/:id/…`) that was folded into a param comes back out as a literal.
 */
function patternsFor(segs: Seg[], entries: Entry[]): { pathPattern: string; urlPattern: string } {
  if (segs.length === 0) return { pathPattern: '/', urlPattern: '^/$' };
  const used = new Map<string, number>();
  const display: string[] = [];
  const regex: string[] = [];
  for (const [i, s] of segs.entries()) {
    const values = s.kind === 'lit' ? [s.value] : [...new Set(entries.map((e) => e.segs[i]!))];
    if (values.length === 1) {
      display.push(values[0]!);
      regex.push(escapeRegex(values[0]!));
      continue;
    }
    const base = values.every(isId) ? 'id' : 'slug';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    display.push(`:${n === 1 ? base : base + n}`);
    regex.push(charClassFor(values));
  }
  return { pathPattern: '/' + display.join('/'), urlPattern: '^/' + regex.join('/') + '$' };
}

function charClassFor(values: string[]): string {
  const all = values.join('');
  if (/^\d+$/.test(all)) return '[0-9]+';
  let cls = '';
  if (/[a-z]/.test(all)) cls += 'a-z';
  if (/[A-Z]/.test(all)) cls += 'A-Z';
  cls += '0-9';
  if (all.includes('_')) cls += '_';
  if (all.includes('.')) cls += '.';
  if (all.includes('-')) cls += '-';
  return `[${cls}]+`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** FNV-1a 32-bit hash; seeds the PRNG. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Partial Fisher–Yates over a sorted copy, so input order never changes the result. */
export function seededSample(ids: readonly string[], n: number, seed: string): string[] {
  const pool = [...ids].sort();
  const rand = mulberry32(hash32(seed));
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, k);
}
