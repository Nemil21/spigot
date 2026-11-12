import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-007b's buyer API key routes (glob-loaded by SP-042's route-table matrix;
 * `apiKeys.db.test.ts` runs them today). Keys are scoped by the session buyer; another buyer's
 * key id is a 404, never a 403.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/buyer/keys',
    as: 'buyer',
    expect: "A's session lists A's keys only (?buyerId=<B> ignored)",
  },
  {
    method: 'POST',
    url: '/api/buyer/keys',
    as: 'buyer',
    expect: 'creates a key for A only (buyerId=<B> in the body ignored)',
  },
  {
    method: 'DELETE',
    url: '/api/buyer/keys/:id',
    as: 'buyer',
    expect: "A's session with B's key id → 404 NOT_FOUND; B's key still works",
  },
];
