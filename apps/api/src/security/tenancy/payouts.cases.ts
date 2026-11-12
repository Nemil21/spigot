import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-021's payout routes (glob-loaded by SP-042's route-table matrix).
 * `routes/payouts.db.test.ts` runs them today.
 */
const ADMIN_ONLY = 'non-admin publisher → 403 FORBIDDEN; buyer or no session → 401';

export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/publishers/me/payouts',
    as: 'publisher',
    expect:
      "B sees only B's items; a batch shared with A shows B's item only (never A's amount, email or ids)",
  },
  {
    method: 'POST',
    url: '/api/publishers/me/payouts/run',
    as: 'publisher',
    expect:
      'non-demo publisher → 403 FORBIDDEN, no batch built; the reply lists only the caller’s item',
  },
  { method: 'POST', url: '/admin/payouts/run', as: 'publisher', expect: ADMIN_ONLY },
  { method: 'POST', url: '/admin/payouts/:batchId/reconcile', as: 'publisher', expect: ADMIN_ONLY },
];
