import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-012a's admin route (glob-loaded by SP-042's route-table matrix).
 * Not tenant-scoped: only `ADMIN_EMAILS` publishers may call it. `schema-agent/propose.db.test.ts`
 * runs these: a non-admin publisher → 403, no session → 401.
 */
export const cases: TenancyCase[] = [
  {
    method: 'POST',
    url: '/admin/sites/:id/repropose',
    as: 'publisher',
    expect:
      'non-admin publisher (even the site owner) → 403 FORBIDDEN, no proposal run; admins only',
  },
];
