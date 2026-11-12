/**
 * Tenancy cases for SP-043's admin ops routes (glob-loaded by SP-042's route-table matrix).
 *
 * These routes are deliberately cross-tenant (they read every publisher's rows), so the case is
 * that only an `ADMIN_EMAILS` publisher reaches them: any other publisher gets 403, a buyer
 * session or no session gets 401. `routes/admin.db.test.ts` runs these cases today.
 */
import type { TenancyCase } from './auth.cases.js';

const ADMIN_ONLY = 'non-admin publisher → 403 FORBIDDEN; buyer or no session → 401';

export const cases: TenancyCase[] = [
  { method: 'GET', url: '/admin/audit', as: 'publisher', expect: ADMIN_ONLY },
  { method: 'POST', url: '/admin/ledger/check', as: 'publisher', expect: ADMIN_ONLY },
  { method: 'GET', url: '/admin/health', as: 'publisher', expect: ADMIN_ONLY },
];
