import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-055's CMS ping (glob-loaded by SP-042's route-table matrix).
 * `crawl/ping.db.test.ts` also runs them. The crawl key alone picks the site: site A's key with
 * B's site id is the same 404 as an id that doesn't exist, and queues nothing for B.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/sites/:id/ping',
    as: 'none',
    expect:
      "site A's crawl key on B's site id → 404 NOT_FOUND (as a random id), nothing queued for B; no key or a publisher cookie → 401",
  },
];
