import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for the public catalog pages `/c/:site` (SP-042 writes these: the route predates
 * the matrix and had no case file). Public by design: a site's slug, LIVE datasets and terms are
 * what the page advertises to agents. `security/tenancy-matrix.db.test.ts` runs them: nobody's
 * private data (owner email or ids, buyers, keys) ever appears, and an unknown slug is a 404.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/c/:site',
    as: 'none',
    expect: "public: the site's LIVE catalog only; never the owner's email, ids or any buyer data",
  },
  {
    method: 'GET',
    url: '/c/:site/terms',
    as: 'none',
    expect: "public: the site's terms only; never the owner's email, ids or any buyer data",
  },
];
