/**
 * Tenancy cases for SP-007a's auth routes (glob-loaded by SP-042's route-table matrix).
 *
 * None of these routes take an id: each acts only on the session's own principal. The case for
 * each is that tenant A's session (with tenant B's id smuggled into the body or query, which must
 * be ignored) only ever sees or changes A. `auth.db.test.ts` runs these cases today; SP-042 may
 * reshape the type when it builds the matrix.
 */
export interface TenancyCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** Whose session makes the call. */
  as: 'publisher' | 'buyer' | 'none';
  /** Why the route is safe, or what the cross-tenant call must return. */
  expect: string;
  /**
   * Tenant B's ids to put in this route's `:param` (one probe per id), for an `/api/…/:param`
   * route SP-042's matrix has no built-in mapping for. Without one, such a route fails the matrix
   * rather than being probed with ids that exist for nobody.
   */
  ids?: (b: TenantB) => string[];
}

/** Tenant B's resources in SP-042's matrix (`security/tenancy-matrix.db.test.ts`). */
export interface TenantB {
  publisherId: string;
  siteId: string;
  siteSlug: string;
  liveDatasetId: string;
  proposedDatasetId: string;
  proposedSchemaId: string;
  crawlRunId: string;
  buyerId: string;
  apiKeyId: string;
  topupId: string;
  callId: string;
}

export const cases: TenancyCase[] = [
  {
    method: 'GET',
    url: '/api/auth/me',
    as: 'publisher',
    expect: "A's session with ?publisherId=<B> returns A only",
  },
  {
    method: 'GET',
    url: '/api/buyer/me',
    as: 'buyer',
    expect: "A's session with ?buyerId=<B> returns A only",
  },
  {
    method: 'POST',
    url: '/api/auth/signup',
    as: 'none',
    expect: 'creates a new publisher; no id input',
  },
  {
    method: 'POST',
    url: '/api/auth/login',
    as: 'none',
    expect: 'signs in the credential owner only',
  },
  {
    method: 'POST',
    url: '/api/auth/logout',
    as: 'publisher',
    expect: 'clears only the caller cookie',
  },
  {
    method: 'POST',
    url: '/api/buyer/signup',
    as: 'none',
    expect: 'creates a new buyer; no id input',
  },
  {
    method: 'POST',
    url: '/api/buyer/login',
    as: 'none',
    expect: 'signs in the credential owner only',
  },
  {
    method: 'POST',
    url: '/api/buyer/logout',
    as: 'buyer',
    expect: 'clears only the caller cookie',
  },
];
