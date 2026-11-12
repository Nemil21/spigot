import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-008b's gate routes (glob-loaded by SP-042's route-table matrix).
 * `gate/gate.db.test.ts` runs them today. The gate routes take no site id: the gate key alone
 * picks the site, so site A's key only ever reads or writes site A.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/gate/policy',
    as: 'none',
    expect:
      "site A's gate key returns A's policy only (B's siteId, prices and paths never appear); no key → 401",
  },
  {
    method: 'POST',
    url: '/api/gate/hits',
    as: 'none',
    expect:
      "site A's gate key writes bot_hits for A only; B's rows and last_gate_seen_at are untouched; no key → 401",
  },
  {
    method: 'GET',
    url: '/api/sites/:id/gate-status',
    as: 'publisher',
    expect: "B's site id → 404 NOT_FOUND",
  },
];
