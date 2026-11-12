import { Faker, en } from '@faker-js/faker';
import { generateSeed, slugify } from './seed.js';
import type { Listing, SiteData } from './types.js';
import {
  FEATURES,
  NEARBY,
  PETS,
  POSTAL_PREFIX,
  STREET_NAMES,
  STREET_SUFFIXES,
  TITLE_ADJECTIVES,
  UNIT_KINDS,
} from './vocab.js';

/**
 * "Demo mutation" planning (SP-004b). Pure functions over SiteData: plan a mutation into a
 * concrete log entry, and apply log entries. The log stores outcomes (slugs, old and new rents,
 * whole new listings), not options, so replay never depends on the RNG or on this code's version.
 */

export const MAX_COUNT = 500;
const DAY_MS = 86_400_000;

export class MutationError extends Error {}

// ---- focus filter -----------------------------------------------------------------------

const NUMERIC_FIELDS = ['price_usd', 'bedrooms', 'bathrooms', 'sqft'] as const;
const STRING_FIELDS = ['city', 'neighbourhood', 'postal_code', 'pets_allowed', 'status'] as const;
type FocusField = (typeof NUMERIC_FIELDS)[number] | (typeof STRING_FIELDS)[number];
type Op = '>=' | '<=' | '!=' | '=' | '>' | '<';

export interface FocusClause {
  field: FocusField;
  op: Op;
  value: number | string;
}

export interface Focus {
  text: string;
  clauses: FocusClause[];
  matches(l: Listing): boolean;
}

/** Parses `"bedrooms>=3,price_usd<2000,city=Austin"`. Clauses are ANDed; strings compare case-insensitively. */
export function parseFocus(text: string): Focus {
  const clauses = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw): FocusClause => {
      const m = /^([a-z_]+)\s*(>=|<=|!=|=|>|<)\s*(.+)$/.exec(raw);
      if (!m)
        throw new MutationError(
          `focus: can't parse "${raw}" (expected field<op>value, op one of >= <= != = > <)`,
        );
      const [, field, op, value] = m as unknown as [string, string, Op, string];
      if ((NUMERIC_FIELDS as readonly string[]).includes(field)) {
        const n = Number(value);
        if (!Number.isFinite(n))
          throw new MutationError(`focus: ${field} needs a number, got "${value}"`);
        return { field: field as FocusField, op, value: n };
      }
      if ((STRING_FIELDS as readonly string[]).includes(field)) {
        if (op !== '=' && op !== '!=')
          throw new MutationError(`focus: ${field} only supports = and !=`);
        return { field: field as FocusField, op, value: value.trim() };
      }
      throw new MutationError(
        `focus: unknown field "${field}" (use ${[...NUMERIC_FIELDS, ...STRING_FIELDS].join(', ')})`,
      );
    });
  if (clauses.length === 0) throw new MutationError('focus: empty filter');
  const test = (c: FocusClause, l: Listing): boolean => {
    const v = l[c.field];
    if (typeof c.value === 'string') {
      const eq = String(v).toLowerCase() === c.value.toLowerCase();
      return c.op === '=' ? eq : !eq;
    }
    const n = v as number;
    switch (c.op) {
      case '>=':
        return n >= c.value;
      case '<=':
        return n <= c.value;
      case '>':
        return n > c.value;
      case '<':
        return n < c.value;
      case '=':
        return n === c.value;
      case '!=':
        return n !== c.value;
    }
  };
  return { text, clauses, matches: (l) => clauses.every((c) => test(c, l)) };
}

// ---- options ------------------------------------------------------------------------------

export interface MutateOptions {
  prices: number;
  leased: number;
  new: number;
  seed: number;
  focus?: string;
  /** CLI only (SP-055): after the mutation, `demo:mutate` pings Spigot with the touched pages. The site ignores it. */
  ping: boolean;
}

function count(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) {
    throw new MutationError(`${key} must be an integer from 0 to ${MAX_COUNT}`);
  }
  return n;
}

/** Validates CLI flags or a `POST /admin/mutate` body. A missing seed gets a random one (echoed in the result). */
export function parseMutateOptions(
  input: Record<string, unknown>,
  randomSeed = () => Math.floor(Math.random() * 1_000_000),
): MutateOptions {
  const prices = count(input, 'prices');
  const leased = count(input, 'leased');
  const added = count(input, 'new');
  if (prices + leased + added === 0)
    throw new MutationError('nothing to change: pass prices, leased and/or new');
  let seed = randomSeed();
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') {
    const s = typeof input.seed === 'string' ? Number(input.seed) : input.seed;
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0)
      throw new MutationError('seed must be a non-negative integer');
    seed = s;
  }
  let focus: string | undefined;
  if (input.focus !== undefined && input.focus !== null && input.focus !== '') {
    if (typeof input.focus !== 'string' || input.focus.length > 200)
      throw new MutationError('focus must be a string (≤ 200 chars)');
    parseFocus(input.focus); // validate early
    focus = input.focus;
  }
  const ping = input.ping === true || input.ping === 'true';
  return { prices, leased, new: added, seed, focus, ping };
}

// ---- log entries ------------------------------------------------------------------------

export interface PriceChange {
  slug: string;
  from: number;
  to: number;
}

export interface MutateEntry {
  kind: 'mutate';
  /** Every touched page's new updated_at / sitemap lastmod. */
  at: string;
  seed: number;
  scale: number;
  focus: string | null;
  prices: PriceChange[];
  leased: string[];
  added: Listing[];
  /** Site paths whose rendered page changed: the listings plus the agent and open-house pages that show them. */
  touched: string[];
}

export interface ResetEntry {
  kind: 'reset';
  at: string;
  scale: number;
  /** Seed pages whose content the reset reverted; their lastmod is `at`. */
  reverted: string[];
  /** Listings added by mutations that the reset removed (404 from now on). */
  removed: string[];
  /** Every page whose lastmod differs from the seed after this reset (reverted ones and earlier resets'). */
  lastmod: Record<string, string>;
}

export type LogEntry = MutateEntry | ResetEntry;

export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A timestamp at or after `now` and strictly after every `previous` one (whole seconds), so a
 * touched page's lastmod always moves forward, even for two mutations in the same second.
 */
export function nextStamp(now: Date, previous: string[]): string {
  let ms = Math.floor(now.getTime() / 1000) * 1000;
  for (const p of previous) ms = Math.max(ms, Date.parse(p) + 1000);
  return isoSeconds(ms);
}

type Page = { updated_at: string };

/** Map of site path → record for every page that has its own lastmod in the sitemap. */
export function pageIndex(data: SiteData): Map<string, Page> {
  const m = new Map<string, Page>();
  for (const l of data.listings) m.set(`/listings/${l.slug}`, l);
  for (const a of data.agents) m.set(`/agents/${a.slug}`, a);
  for (const o of data.openHouses) m.set(`/open-houses/${o.id}`, o);
  return m;
}

/**
 * Pages whose HTML shows a listing's data: the listing page itself, its agent's page (active
 * listing cards and counts) and its open houses (rent). Their ETag changes with the listing,
 * so their lastmod moves with it.
 */
function pagesShowing(data: SiteData, listing: Listing, opts: { openHouses: boolean }): string[] {
  const paths = [`/listings/${listing.slug}`, `/agents/${listing.agent_slug}`];
  if (opts.openHouses) {
    for (const o of data.openHouses)
      if (o.listing_slug === listing.slug) paths.push(`/open-houses/${o.id}`);
  }
  return paths;
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

function newRent(
  f: Faker,
  from: number,
  focus: Focus | undefined,
  listing: Listing,
): number | undefined {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pct = f.number.float({ min: 0.03, max: 0.08 });
    const signs = f.datatype.boolean() ? [1, -1] : [-1, 1];
    for (const sign of signs) {
      const to = round5(from * (1 + sign * pct));
      const ratio = Math.abs(to - from) / from;
      if (ratio < 0.03 || ratio > 0.08) continue;
      if (focus && !focus.matches({ ...listing, price_usd: to })) continue;
      return to;
    }
  }
  return undefined;
}

function newListing(
  f: Faker,
  data: SiteData,
  id: number,
  template: Listing,
  focus: Focus | undefined,
  at: string,
): Listing | undefined {
  const { city, neighbourhood, bedrooms, bathrooms } = template;
  const street = `${f.helpers.arrayElement(STREET_NAMES)} ${f.helpers.arrayElement(STREET_SUFFIXES)}`;
  const unit = f.datatype.boolean(0.55)
    ? ` ${f.helpers.arrayElement(UNIT_KINDS)} ${f.number.int({ min: 1, max: 340 })}`
    : '';
  const bedsLabel = bedrooms === 0 ? 'Studio' : `${bedrooms}-bed`;
  const atMs = Date.parse(at);
  const candidate: Listing = {
    id,
    slug: `${bedrooms === 0 ? 'studio' : `${bedrooms}br`}-${slugify(neighbourhood)}-${slugify(street)}-${id}`,
    title: `${f.helpers.arrayElement(TITLE_ADJECTIVES)} ${bedsLabel} in ${neighbourhood}`,
    description: `${bedrooms === 0 ? 'A studio' : `A ${bedrooms}-bedroom home`} on ${street} with ${f.helpers
      .arrayElements(FEATURES, 2)
      .join(' and ')}, ${f.helpers.arrayElement(NEARBY)}.`,
    price_usd: round5(template.price_usd * (1 + f.number.float({ min: -0.05, max: 0.05 }))),
    bedrooms,
    bathrooms,
    sqft: round5(template.sqft * (1 + f.number.float({ min: -0.08, max: 0.08 }))),
    street_address: `${f.number.int({ min: 100, max: 9899 })} ${street}${unit}`,
    city,
    state: 'TX',
    postal_code: `${POSTAL_PREFIX[city] ?? template.postal_code.slice(0, 3)}${String(f.number.int({ min: 1, max: 99 })).padStart(2, '0')}`,
    neighbourhood,
    available_from: new Date(atMs + f.number.int({ min: 0, max: 30 }) * DAY_MS)
      .toISOString()
      .slice(0, 10),
    pets_allowed: f.helpers.weightedArrayElement(PETS),
    status: 'available',
    agent_slug: f.helpers.arrayElement(data.agents).slug,
    created_at: at,
    updated_at: at,
  };
  if (focus && !focus.matches(candidate)) {
    // The jittered rent or size may have left the filter; the template's own values satisfy it.
    candidate.price_usd = template.price_usd;
    candidate.sqft = template.sqft;
    if (!focus.matches(candidate)) return undefined;
  }
  return candidate;
}

/**
 * Plans one demo mutation against `data` (not modified): `prices` rent changes of ±3–8%,
 * `leased` status changes and `new` listings, on disjoint listings. With a focus filter, price
 * changes are drawn from (and stay inside) the focus population and new listings match it.
 * Only available listings are re-priced or leased. Same data + same seed → same entry.
 */
export function planMutation(data: SiteData, opts: MutateOptions, now: Date): MutateEntry {
  const f = new Faker({ locale: [en] });
  f.seed(opts.seed);
  const focus = opts.focus ? parseFocus(opts.focus) : undefined;
  const available = data.listings.filter((l) => l.status === 'available');

  const prices: PriceChange[] = [];
  const pricePool = f.helpers.shuffle(
    focus ? available.filter((l) => focus.matches(l)) : available,
  );
  for (const l of pricePool) {
    if (prices.length === opts.prices) break;
    const to = newRent(f, l.price_usd, focus, l);
    if (to !== undefined) prices.push({ slug: l.slug, from: l.price_usd, to });
  }
  if (prices.length < opts.prices) {
    throw new MutationError(
      `only ${prices.length} available listings${focus ? ` match focus "${focus.text}"` : ''}; asked for ${opts.prices} price changes`,
    );
  }

  const repriced = new Set(prices.map((p) => p.slug));
  const leasePool = available.filter((l) => !repriced.has(l.slug));
  if (leasePool.length < opts.leased) {
    throw new MutationError(
      `only ${leasePool.length} other available listings; asked to lease ${opts.leased}`,
    );
  }
  const leased = f.helpers.arrayElements(leasePool, opts.leased).map((l) => l.slug);

  // New listings copy the shape (city, neighbourhood, beds, baths) of a template listing.
  const templates = focus ? data.listings.filter((l) => focus.matches(l)) : data.listings;
  if (opts.new > 0 && templates.length === 0)
    throw new MutationError(`no listing matches focus "${focus?.text}" to model new listings on`);
  const placeholder = isoSeconds(now.getTime());
  let nextId = data.listings.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  const added: Listing[] = [];
  for (let i = 0; i < opts.new; i++) {
    let listing: Listing | undefined;
    for (let attempt = 0; attempt < 20 && !listing; attempt++) {
      listing = newListing(f, data, nextId, f.helpers.arrayElement(templates), focus, placeholder);
    }
    if (!listing)
      throw new MutationError(`couldn't build a new listing matching focus "${focus?.text}"`);
    added.push(listing);
    nextId += 1;
  }

  const bySlug = new Map(data.listings.map((l) => [l.slug, l]));
  const touched = new Set<string>();
  for (const p of prices)
    for (const path of pagesShowing(data, bySlug.get(p.slug)!, { openHouses: true }))
      touched.add(path);
  // Open-house pages show rent, not status, so a lease doesn't change them.
  for (const slug of leased)
    for (const path of pagesShowing(data, bySlug.get(slug)!, { openHouses: false }))
      touched.add(path);
  for (const l of added) touched.add(`/agents/${l.agent_slug}`);

  const pages = pageIndex(data);
  const at = nextStamp(
    now,
    [...touched].map((p) => pages.get(p)?.updated_at ?? placeholder),
  );
  for (const l of added) {
    l.created_at = at;
    l.updated_at = at;
    touched.add(`/listings/${l.slug}`);
  }

  return {
    kind: 'mutate',
    at,
    seed: opts.seed,
    scale: data.scale,
    focus: focus?.text ?? null,
    prices,
    leased,
    added,
    touched: [...touched].sort(),
  };
}

/** Applies a log entry to `data` in place. Throws if the entry doesn't fit the data (a log from another seed). */
export function applyEntry(data: SiteData, entry: LogEntry): void {
  if (entry.scale !== data.scale) {
    throw new MutationError(
      `mutation log was written at DEMO_SEED_SCALE=${entry.scale}, the site runs at ${data.scale}; POST /admin/reset or delete the log`,
    );
  }
  if (entry.kind === 'reset') {
    const seed = generateSeed(data.scale);
    Object.assign(data, seed);
    const pages = pageIndex(data);
    for (const [path, at] of Object.entries(entry.lastmod)) {
      const page = pages.get(path);
      if (page) page.updated_at = at;
    }
    return;
  }
  const bySlug = new Map(data.listings.map((l) => [l.slug, l]));
  const get = (slug: string) => {
    const l = bySlug.get(slug);
    if (!l) throw new MutationError(`mutation log names unknown listing ${slug}`);
    return l;
  };
  for (const p of entry.prices) get(p.slug).price_usd = p.to;
  for (const slug of entry.leased) get(slug).status = 'leased';
  for (const l of entry.added) {
    if (bySlug.has(l.slug)) throw new MutationError(`mutation log adds ${l.slug} twice`);
    data.listings.push({ ...l });
  }
  const pages = pageIndex(data);
  for (const path of entry.touched) {
    const page = pages.get(path);
    if (page) page.updated_at = entry.at;
  }
}

/**
 * Plans a reset: back to the seed. Pages that mutations since the last reset touched (and
 * that still exist in the seed) get `lastmod = at`, newer than anything they had, so the next
 * crawl re-fetches them and Spigot's records revert too. Pages an earlier reset bumped keep
 * that lastmod, so no page's lastmod ever moves backwards.
 */
export function planReset(data: SiteData, log: readonly LogEntry[], now: Date): ResetEntry {
  const current = pageIndex(data);
  const seed = generateSeed(data.scale);
  const seedPages = pageIndex(seed);
  const touched = new Set(log.flatMap((e) => (e.kind === 'mutate' ? e.touched : [])));
  const reverted = [...touched].filter((p) => seedPages.has(p)).sort();
  const seedSlugs = new Set(seed.listings.map((l) => l.slug));
  const removed = data.listings.filter((l) => !seedSlugs.has(l.slug)).map((l) => l.slug);
  const at = nextStamp(
    now,
    reverted.map((p) => current.get(p)!.updated_at),
  );

  const lastmod: Record<string, string> = {};
  for (const e of log) if (e.kind === 'reset') Object.assign(lastmod, e.lastmod);
  for (const p of reverted) lastmod[p] = at;
  return { kind: 'reset', at, scale: data.scale, reverted, removed, lastmod };
}
