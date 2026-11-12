import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-058's Log in with PayPal routes. Neither takes an id: `/start` links only
 * the session's own publisher (kept in the signed state cookie) and `/callback` acts only on the
 * publisher in that cookie, which must still be the session's. Anonymous callers get a 302.
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/auth/paypal/start',
    as: 'none',
    expect: '302 to PayPal; smuggled ids ignored (the link target is the session publisher only)',
  },
  {
    method: 'GET',
    url: '/api/auth/paypal/callback',
    as: 'none',
    expect: 'without a matching state cookie: 302 ?paypal=state; nobody is signed in or linked',
  },
];
