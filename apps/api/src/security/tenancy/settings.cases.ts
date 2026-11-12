import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-034's W16 settings routes (glob-loaded by SP-042's route-table matrix).
 * `settings/settings.db.test.ts` runs them today: tenant A's session against tenant B's ids.
 */
export const cases: TenancyCase[] = [
  {
    method: 'PATCH',
    url: '/api/publishers/me',
    as: 'publisher',
    expect: "changes only the session publisher; B's name and payout email are untouched",
  },
  {
    method: 'PATCH',
    url: '/api/sites/:id/policy',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; B's policy and policy_version are unchanged",
  },
  {
    method: 'POST',
    url: '/api/sites/:id/keys/rotate',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND; B's key hashes are unchanged",
  },
];
