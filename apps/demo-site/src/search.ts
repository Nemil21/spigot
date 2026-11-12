import type { Listing } from './data/types.js';

export interface SearchQuery {
  beds?: number;
  maxRent?: number;
  neighbourhood?: string;
  page: number;
}

export const PAGE_SIZE = 24;

function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseSearchQuery(q: Record<string, unknown>): SearchQuery {
  const neighbourhood = typeof q.neighbourhood === 'string' && q.neighbourhood.trim() ? q.neighbourhood.trim() : undefined;
  return {
    beds: intParam(q.beds),
    maxRent: intParam(q.max_rent),
    neighbourhood,
    page: Math.max(1, intParam(q.page) ?? 1),
  };
}

/** `beds` is a minimum ("3+ beds"); `max_rent` is inclusive. Leased listings sort last. */
export function searchListings(listings: readonly Listing[], q: SearchQuery): { total: number; results: Listing[] } {
  const matches = listings.filter(
    (l) =>
      (q.beds === undefined || l.bedrooms >= q.beds) &&
      (q.maxRent === undefined || l.price_usd <= q.maxRent) &&
      (q.neighbourhood === undefined || l.neighbourhood === q.neighbourhood),
  );
  matches.sort((a, b) => Number(a.status === 'leased') - Number(b.status === 'leased') || a.id - b.id);
  const start = (q.page - 1) * PAGE_SIZE;
  return { total: matches.length, results: matches.slice(start, start + PAGE_SIZE) };
}
