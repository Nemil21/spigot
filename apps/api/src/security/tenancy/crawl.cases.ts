import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-009b's crawl routes (glob-loaded by SP-042's route-table matrix).
 * `crawl/crawlApi.db.test.ts` runs them today: tenant A's session against tenant B's ids.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/sites/:id/crawl',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; no crawl_runs row is created for B's site",
  },
  {
    method: 'POST',
    url: '/api/sites/:id/resume',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; B's PAUSED site stays PAUSED",
  },
  {
    method: 'GET',
    url: '/api/sites/:id/crawl-runs',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND",
  },
  {
    method: 'GET',
    url: '/api/crawl-runs/:id/events',
    as: 'publisher',
    expect: "B's crawl run id → 404 NOT_FOUND (no stream opened)",
  },
];
