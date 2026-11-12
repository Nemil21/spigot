import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-053's W07 records browser (glob-loaded by SP-042's route-table matrix).
 * `records/records-browser.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/sites/:id/datasets',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; A's list never includes B's datasets",
  },
  {
    method: 'GET',
    url: '/api/datasets/:id/records',
    as: 'publisher',
    expect: "B's dataset id → 404 NOT_FOUND, never B's rows or row count",
  },
  {
    method: 'GET',
    url: '/api/records/:id/versions',
    as: 'publisher',
    expect: "B's record id → 404 NOT_FOUND, never B's patches",
  },
];
