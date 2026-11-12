import type { TenancyCase } from './auth.cases.js';

/**
 * Tenancy cases for SP-017b's buyer data API `/v1` (glob-loaded by SP-042's route-table matrix).
 * `routes/v1.db.test.ts` runs them today. `as: 'buyer'` here means an API key (Bearer), not a
 * portal session. Catalog data is public by design; the tenant-scoped state is the buyer's
 * balance, charges and `api_calls` (idempotency keys are scoped per API key).
 */
export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/v1/catalog',
    as: 'none',
    expect: 'public: LIVE / LIVE_STALE datasets only, no buyer or publisher-private data',
  },
  {
    method: 'GET',
    url: '/v1/:site/datasets/:dataset',
    as: 'none',
    expect:
      'public: visible schema fields only (hidden fields never listed); unpublished → 410, proposals → 404',
  },
  {
    method: 'GET',
    url: '/v1/:site/datasets/:dataset/quote',
    as: 'buyer',
    expect: "B's key shows B's balance only; ?buyerId=<A> is not accepted (400 UNSUPPORTED_FILTER)",
  },
  {
    method: 'GET',
    url: '/v1/:site/datasets/:dataset/records',
    as: 'buyer',
    expect:
      "charges the key's own buyer only; B reusing A's Idempotency-Key gets a new call charged to B, never A's stored response",
  },
  {
    method: 'GET',
    url: '/v1/:site/datasets/:dataset/records/:key',
    as: 'buyer',
    expect: "charges the key's own buyer only; hidden fields never served",
  },
  {
    method: 'GET',
    url: '/v1/:site/datasets/:dataset/changes',
    as: 'buyer',
    expect: "charges the key's own buyer only; hidden-field patch ops dropped",
  },
  {
    method: 'GET',
    url: '/v1/balance',
    as: 'buyer',
    expect: "B's key returns B's balance only; ?buyerId=<A> is ignored",
  },
];
