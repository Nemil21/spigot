import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-055's CMS ping (glob-loaded by SP-042's route-table matrix).
 * `crawl/ping.db.test.ts` runs them today. The crawl key alone picks the site: site A's key
 * with B's site id is the same 401 as a bad key, and queues nothing for B.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/sites/:id/ping',
    as: 'none',
    expect:
      "site A's crawl key on B's site id → 401 UNAUTHENTICATED, nothing queued for B; a publisher cookie (no key) → 401",
  },
];
