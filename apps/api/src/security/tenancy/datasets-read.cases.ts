import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-014b's W05 / W06 reads (glob-loaded by SP-042's route-table matrix).
 * `datasets/datasets-read.db.test.ts` runs them today.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/sites/:id/proposals',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; A's proposals never include B's datasets",
  },
  {
    method: 'GET',
    url: '/api/datasets/:id',
    as: 'publisher',
    expect: "B's dataset id (PROPOSED or LIVE) → 404 NOT_FOUND, never B's fields or sample rows",
  },
];
