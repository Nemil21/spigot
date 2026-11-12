// Template clustering (features/04 §1). Pure: no Node-only APIs, so apps/web can import it.
//
// Pages are grouped by URL path shape: a path segment whose value varies across at least
// `paramMinDistinct` pages with slug/number shapes becomes a `:param`. Each group is then split
// by its JSON-LD `@type` set, small groups are dropped, and 5 sample pages are picked with a
// seeded shuffle so the same input always yields the same samples.
//
// P1 (SP-065): `confirmCluster` checks each template against page DOM fingerprints (tag-path
// shingles) and splits a URL pattern that mixes layouts into sub-templates (Jaccard < 0.8).

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
  /**
   * Set by `confirmCluster` when one URL pattern holds several kept layouts: 1 for the largest
   * sub-template, 2 for the next, … Sub-templates share `urlPattern`; pages map by id.
   */
  variant?: number;
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

// WHATWG URL exists in browsers and Node; lib ES2022 with types [] doesn't declare it.
declare const URL: new (url: string, base?: string) => { pathname: string };

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

export type Fingerprint = ReadonlySet<string>;

export interface FingerprintOptions {
  /** Tags per shingle: the element plus up to `depth - 1` of its nearest ancestors. */
  depth?: number;
}

export const FINGERPRINT_DEFAULTS = { depth: 4 } as const satisfies Required<FingerprintOptions>;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);
/** Content is skipped: text or a foreign tree, not page layout. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'svg', 'math']);
/** An open tag that implicitly closes an open sibling of the listed tags (HTML optional end tags). */
const IMPLIED_CLOSE: Record<string, readonly string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  p: ['p'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
};
const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const CLASS_RE = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const STABLE_CLASS_RE = /^[A-Za-z_-]+$/;

/**
 * Tag-path shingles of a page's `<body>`: for each element, the path of its last `depth` tags
 * (each `tag` or `tag.firstClass`) from the root. Text, attributes other than the first class,
 * scripts/styles and repeat counts don't count, so pages of one template share a fingerprint
 * even when their content and list lengths differ. Pure string scan, no DOM: browser-safe.
 */
export function fingerprint(html: string, options: FingerprintOptions = {}): Set<string> {
  const { depth } = { ...FINGERPRINT_DEFAULTS, ...options };
  const bodyAt = html.search(/<body[\s>]/i);
  const src = bodyAt >= 0 ? html.slice(bodyAt) : html;
  const lower = src.toLowerCase();
  const shingles = new Set<string>();
  const stack: { tag: string; token: string }[] = [];
  const re = new RegExp(TAG_RE.source, 'g');

  for (let m = re.exec(src); m; m = re.exec(src)) {
    const tag = m[2]?.toLowerCase();
    if (!tag) continue; // comment
    if (m[1]) {
      let at = stack.length - 1;
      while (at >= 0 && stack[at]!.tag !== tag) at--;
      if (at >= 0) stack.length = at;
      continue;
    }
    if (tag === 'body') continue;
    if (SKIP_TAGS.has(tag)) {
      const end = lower.indexOf(`</${tag}`, re.lastIndex);
      re.lastIndex = end < 0 ? src.length : end;
      continue;
    }
    const closes = IMPLIED_CLOSE[tag];
    const top = stack[stack.length - 1];
    if (closes && top && closes.includes(top.tag)) stack.pop();

    const attrs = m[3] ?? '';
    const cm = CLASS_RE.exec(attrs);
    const cls = (cm?.[1] ?? cm?.[2] ?? cm?.[3] ?? '').split(/\s+/).find((c) => STABLE_CLASS_RE.test(c));
    const token = cls ? `${tag}.${cls}` : tag;
    const path = [...stack.slice(-(depth - 1)).map((e) => e.token), token];
    shingles.add(path.join('>'));
    if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, token });
  }
  return shingles;
}

/** |A ∩ B| / |A ∪ B|; two empty fingerprints count as identical. */
export function jaccard(a: Fingerprint, b: Fingerprint): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface ConfirmOptions extends ClusterOptions {
  /** Two layouts are the same template when their fingerprints' Jaccard is at least this. */
  threshold?: number;
  /**
   * Above this many distinct fingerprints in one template the pairwise check is skipped and the
   * template is returned unchanged (keeps the cost bounded on very large, very varied sites).
   */
  maxDistinct?: number;
}

export const CONFIRM_DEFAULTS = {
  ...CLUSTER_DEFAULTS,
  threshold: 0.8,
  maxDistinct: 2000,
} as const satisfies Required<ConfirmOptions>;

export type FingerprintsByPageId =
  | ReadonlyMap<string, Fingerprint>
  | ((pageId: string) => Fingerprint | undefined);

/**
 * Confirms a URL-pattern template with DOM fingerprints (features/04 §1, P1). Distinct
 * fingerprints are linked when their Jaccard is ≥ `threshold`; each connected group is one
 * layout. One layout → the same template object back, unchanged. Several → one sub-template
 * per layout (`variant` 1, 2, …, largest first) with fresh seeded samples. Layouts with fewer
 * than `minPages` pages are dropped, so stray pages leave the template and a pattern of one-off
 * pages (`/about`-like, no repeated structure) drops out entirely.
 *
 * Pass fingerprints for every page you have a snapshot of. Pages without one can't be placed,
 * so they stay with the largest layout. With no fingerprints the template is returned as is.
 */
export function confirmCluster(
  template: Template,
  fingerprints: FingerprintsByPageId,
  options: ConfirmOptions = {},
): Template[] {
  const opts = { ...CONFIRM_DEFAULTS, ...options };
  const fpOf = typeof fingerprints === 'function' ? fingerprints : (id: string) => fingerprints.get(id);

  // Pages with identical fingerprints are one node; most pages of a real template collapse here.
  const nodes = new Map<string, { fp: Fingerprint; pageIds: string[] }>();
  const unplaced: string[] = [];
  for (const id of template.pageIds) {
    const fp = fpOf(id);
    if (!fp) {
      unplaced.push(id);
      continue;
    }
    const key = [...fp].sort().join('\n');
    const node = nodes.get(key);
    if (node) node.pageIds.push(id);
    else nodes.set(key, { fp, pageIds: [id] });
  }
  if (nodes.size <= 1 || nodes.size > opts.maxDistinct) return [template];

  // Union-find over distinct fingerprints: order-independent single-linkage grouping.
  const list = [...nodes.values()];
  const parent = list.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (find(i) !== find(j) && jaccard(list[i]!.fp, list[j]!.fp) >= opts.threshold) {
        parent[find(j)] = find(i);
      }
    }
  }
  const byRoot = new Map<number, string[]>();
  for (const [i, n] of list.entries()) {
    const ids = byRoot.get(find(i)) ?? [];
    ids.push(...n.pageIds);
    byRoot.set(find(i), ids);
  }
  if (byRoot.size === 1) return [template];

  const layouts = [...byRoot.values()]
    .map((ids) => ids.sort())
    .sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
  layouts[0]!.push(...unplaced);
  layouts[0]!.sort();

  const types = template.jsonldTypes.join(',');
  const kept = layouts.filter((ids) => ids.length >= opts.minPages);
  return kept.map((pageIds, i) => ({
      pathPattern: template.pathPattern,
      urlPattern: template.urlPattern,
      jsonldTypes: [...template.jsonldTypes],
      pageCount: pageIds.length,
      pageIds,
      samplePageIds: seededSample(
        pageIds,
        opts.sampleSize,
        `${opts.seed}|${template.urlPattern}|${types}|v${i + 1}`,
      ),
      ...(kept.length > 1 ? { variant: i + 1 } : {}),
    }));
}

/** `confirmCluster` over every template from `clusterUrls`, keeping their order. */
export function confirmClusters(
  templates: readonly Template[],
  fingerprints: FingerprintsByPageId,
  options: ConfirmOptions = {},
): Template[] {
  return templates.flatMap((t) => confirmCluster(t, fingerprints, options));
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
