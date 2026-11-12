import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-008a's site routes (glob-loaded by SP-042's route-table matrix).
 * `sites/sites.db.test.ts` runs them today: tenant A's session against tenant B's site id.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/api/sites',
    as: 'publisher',
    expect: 'creates a site owned by the session publisher; a publisherId in the body is ignored',
  },
  {
    method: 'GET',
    url: '/api/sites',
    as: 'publisher',
    expect: "lists only A's sites, never B's",
  },
  {
    method: 'GET',
    url: '/api/sites/:id',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND",
  },
  {
    method: 'POST',
    url: '/api/sites/:id/verify',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; B's site stays PENDING_VERIFY",
  },
];
