import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * Log in with PayPal (SP-058; features/14 §Auth): the OpenID Connect auth-code flow for
 * publishers. Ported from Holdfast HF-010.
 *
 *   1. authorize  https://www.sandbox.paypal.com/signin/authorize?client_id&response_type=code
 *                 &scope=openid email https://uri.paypal.com/services/paypalattributes
 *                 &redirect_uri&state&nonce
 *   2. token      POST {PAYPAL_API_BASE}/v1/oauth2/token  grant_type=authorization_code&code=…
 *                 (Basic client credentials, server side only: the secret never reaches a browser)
 *   3. userinfo   GET  {PAYPAL_API_BASE}/v1/identity/oauth2/userinfo?schema=paypalv1.1  (Bearer)
 *
 * `state` and `nonce` live in a signed, 10-minute, HttpOnly cookie set by `/start`. The `nonce`
 * is checked against the `id_token` when PayPal returns one; the token comes straight from PayPal
 * over TLS on the back channel, so its signature is not re-verified (OIDC Core §3.1.3.7).
 *
 * `PAYPAL_MODE=stub` (and tests) use `StubPayPalIdentity`: a stub OIDC provider whose authorize
 * step points straight back at the callback with a one-time code; the code exchange still runs
 * through `RestPayPalIdentity` over the stub's `fetch`, so the whole protocol is exercised.
 */

export const LIPP_SCOPES = ['openid', 'email', 'https://uri.paypal.com/services/paypalattributes'];

export interface PayPalLoginIdentity {
  /** Lower-cased PayPal email; becomes `payout_email`. */
  email: string;
  emailVerified: boolean;
  /** PayPal payer id (needs the `paypalattributes` scope) → `publishers.paypal_payer_id`. */
  payerId: string | null;
  name: string | null;
}

export interface AuthorizeInput {
  state: string;
  nonce: string;
  redirectUri: string;
}

export interface PayPalIdentity {
  /** The consent URL the browser is sent to. Carries only public values. */
  authorizeUrl(input: AuthorizeInput): string;
  /** Exchange an authorization code; rejects with `PayPalLoginError` (also on a nonce mismatch). */
  exchange(code: string, nonce: string): Promise<PayPalLoginIdentity>;
}

/** Why an exchange failed; never carries the code, tokens or credentials. */
export class PayPalLoginError extends Error {
  constructor(
    readonly stage: 'token' | 'id_token' | 'userinfo',
    readonly http: number,
    readonly code: string,
  ) {
    super(`Log in with PayPal ${stage} failed: ${code} (HTTP ${http})`);
    this.name = 'PayPalLoginError';
  }
}

/** The consent host that pairs with an API base (sandbox API → sandbox consent). */
export function authorizeBaseFor(apiBase: string): string {
  const host = new URL(apiBase).hostname;
  return host.includes('sandbox') ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
}

/** Where PayPal sends the browser back. Must be registered on the PayPal app (manual step). */
export function callbackUrl(config: Config): string {
  return `${config.APP_BASE_URL.replace(/\/+$/, '')}/api/auth/paypal/callback`;
}

const truthy = (v: unknown) => v === true || v === 'true';

/** Reads a userinfo body defensively (OIDC and paypalv1.1 schemas). Null when there's no email. */
export function identityFromUserinfo(json: Record<string, unknown>): PayPalLoginIdentity | null {
  const emails = Array.isArray(json.emails)
    ? (json.emails as Array<Record<string, unknown>>).filter(
        (e) => e && typeof e.value === 'string',
      )
    : [];
  const primary = emails.find((e) => truthy(e.primary)) ?? emails[0];
  const email =
    typeof json.email === 'string' ? json.email : primary ? (primary.value as string) : null;
  if (!email) return null;
  // OIDC's `email_verified`, else the paypalv1.1 `confirmed` flag on that same address.
  const chosen = emails.find((e) => String(e.value).toLowerCase() === email.toLowerCase());
  const emailVerified =
    'email_verified' in json ? truthy(json.email_verified) : truthy(chosen?.confirmed);
  const payerId = typeof json.payer_id === 'string' && json.payer_id ? json.payer_id : null;
  const name = typeof json.name === 'string' && json.name.trim() ? json.name.trim() : null;
  return { email: email.trim().toLowerCase(), emailVerified, payerId, name };
}

/** The `id_token` claims (payload only; see the module note on signatures), or null if malformed. */
export function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Check the token response's `id_token` against our `nonce` and client id. PayPal may omit the
 * `id_token`; then `state` (checked by the route) is the replay guard and this passes.
 */
export function checkIdToken(idToken: unknown, nonce: string, clientId: string): void {
  if (idToken === undefined || idToken === null) return;
  const claims = typeof idToken === 'string' ? idTokenClaims(idToken) : null;
  if (!claims) throw new PayPalLoginError('id_token', 200, 'MALFORMED');
  if (typeof claims.nonce !== 'string' || !sameSecret(claims.nonce, nonce)) {
    throw new PayPalLoginError('id_token', 200, 'NONCE_MISMATCH');
  }
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (aud !== undefined && !audiences.includes(clientId)) {
    throw new PayPalLoginError('id_token', 200, 'AUDIENCE_MISMATCH');
  }
}

export interface RestPayPalIdentityOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  /** Consent host; default from `apiBase`. The stub provider sets its own. */
  authorizeBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class RestPayPalIdentity implements PayPalIdentity {
  readonly #opts: RestPayPalIdentityOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: RestPayPalIdentityOptions) {
    this.#opts = { ...opts, apiBase: opts.apiBase.replace(/\/+$/, '') };
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  authorizeUrl({ state, nonce, redirectUri }: AuthorizeInput): string {
    const q = new URLSearchParams({
      flowEntry: 'static',
      client_id: this.#opts.clientId,
      response_type: 'code',
      scope: LIPP_SCOPES.join(' '),
      redirect_uri: redirectUri,
      state,
      nonce,
    });
    const base = this.#opts.authorizeBase ?? authorizeBaseFor(this.#opts.apiBase);
    return `${base}/signin/authorize?${q.toString()}`;
  }

  async exchange(code: string, nonce: string): Promise<PayPalLoginIdentity> {
    const basic = Buffer.from(`${this.#opts.clientId}:${this.#opts.clientSecret}`).toString(
      'base64',
    );
    const token = await this.#call('token', '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== 'string') throw new PayPalLoginError('token', 200, 'NO_TOKEN');
    checkIdToken(token.id_token, nonce, this.#opts.clientId);

    const info = await this.#call('userinfo', '/v1/identity/oauth2/userinfo?schema=paypalv1.1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const identity = identityFromUserinfo(info);
    if (!identity) throw new PayPalLoginError('userinfo', 200, 'NO_EMAIL');
    return identity;
  }

  async #call(
    stage: 'token' | 'userinfo',
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(this.#opts.apiBase + path, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      throw new PayPalLoginError(stage, 0, timeout ? 'TIMEOUT' : 'NETWORK');
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON answer: handled by the status check below.
    }
    if (!res.ok) {
      // `invalid_grant` = used or expired code. Only PayPal's error code is kept.
      const code = typeof json.error === 'string' ? json.error : `HTTP_${res.status}`;
      throw new PayPalLoginError(stage, res.status, code);
    }
    return json;
  }
}

// --- Stub OIDC provider (PAYPAL_MODE=stub, tests) ---------------------------------------------

export const STUB_OIDC_BASE = 'https://fake-identity.paypal.local';

/** The identity a stub sign-in resolves to by default: a publisher that hasn't signed up yet. */
export const STUB_LIPP_IDENTITY: PayPalLoginIdentity = {
  email: 'paypal-publisher@spigot.demo',
  emailVerified: true,
  payerId: 'STUBPAYER0000001',
  name: 'PayPal Publisher (stub)',
};

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/**
 * An in-memory OIDC provider speaking PayPal's token and userinfo endpoints. `consent()` plays
 * the user approving on PayPal and mints a one-time code bound to the request's nonce; `fetch`
 * serves the code exchange. Codes are single use (a replay is `400 invalid_grant`), tokens are
 * per-code, and the `id_token` carries the nonce and `aud`.
 */
export class StubOidcProvider {
  /** Every code presented to the token endpoint, valid or not. */
  readonly exchanged: string[] = [];
  /** Set to make the next exchange fail like PayPal would (e.g. `server_error`). */
  failNext: { http: number; error: string } | null = null;
  #codes = new Map<string, { identity: PayPalLoginIdentity; nonce: string }>();
  #tokens = new Map<string, PayPalLoginIdentity>();

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  consent(nonce: string, identity: PayPalLoginIdentity = STUB_LIPP_IDENTITY): string {
    const code = `stubcode_${randomBytes(12).toString('base64url')}`;
    this.#codes.set(code, { identity: { ...identity }, nonce });
    return code;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    if (url.pathname === '/v1/oauth2/token' && init?.method === 'POST') {
      const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      if (headers.get('authorization') !== basic) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      const form = new URLSearchParams(String(init.body ?? ''));
      const code = form.get('code') ?? '';
      this.exchanged.push(code);
      if (this.failNext) {
        const { http, error } = this.failNext;
        this.failNext = null;
        return Response.json({ error }, { status: http });
      }
      const grant = this.#codes.get(code);
      if (form.get('grant_type') !== 'authorization_code' || !grant) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      this.#codes.delete(code);
      const accessToken = `stubat_${randomBytes(12).toString('base64url')}`;
      this.#tokens.set(accessToken, grant.identity);
      const idToken = [
        b64json({ alg: 'none', typ: 'JWT' }),
        b64json({
          iss: STUB_OIDC_BASE,
          aud: this.clientId,
          sub: grant.identity.payerId,
          nonce: grant.nonce,
        }),
        'stub',
      ].join('.');
      return Response.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 28_800,
        id_token: idToken,
      });
    }
    if (url.pathname === '/v1/identity/oauth2/userinfo' && init?.method === 'GET') {
      const identity = this.#tokens.get(
        (headers.get('authorization') ?? '').replace(/^Bearer /, ''),
      );
      if (!identity) return Response.json({ error: 'invalid_token' }, { status: 401 });
      return Response.json({
        user_id: `https://www.paypal.com/webapps/auth/identity/user/${identity.payerId ?? 'x'}`,
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.payerId ? { payer_id: identity.payerId } : {}),
        emails: [{ value: identity.email, primary: true, confirmed: identity.emailVerified }],
      });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }) as typeof fetch;
}

/**
 * `PAYPAL_MODE=stub`: the authorize URL skips PayPal's consent page and comes straight back to
 * the callback with a code for `identity` (default `STUB_LIPP_IDENTITY`).
 */
export class StubPayPalIdentity implements PayPalIdentity {
  readonly provider: StubOidcProvider;
  identity: PayPalLoginIdentity;
  readonly #rest: RestPayPalIdentity;

  constructor(
    opts: { clientId?: string; identity?: PayPalLoginIdentity; provider?: StubOidcProvider } = {},
  ) {
    this.provider =
      opts.provider ?? new StubOidcProvider(opts.clientId ?? 'stub-client', 'stub-secret');
    this.identity = opts.identity ?? STUB_LIPP_IDENTITY;
    this.#rest = new RestPayPalIdentity({
      apiBase: STUB_OIDC_BASE,
      authorizeBase: STUB_OIDC_BASE,
      clientId: this.provider.clientId,
      clientSecret: this.provider.clientSecret,
      fetch: this.provider.fetch,
    });
  }

  authorizeUrl({ state, nonce, redirectUri }: AuthorizeInput): string {
    const q = new URLSearchParams({ code: this.provider.consent(nonce, this.identity), state });
    return `${redirectUri}?${q.toString()}`;
  }

  exchange(code: string, nonce: string): Promise<PayPalLoginIdentity> {
    return this.#rest.exchange(code, nonce);
  }
}

let override: PayPalIdentity | undefined;
const cache = new WeakMap<Config, PayPalIdentity>();

/** The identity client for this process (`PAYPAL_MODE=stub` → `StubPayPalIdentity`). */
export function paypalIdentity(config: Config): PayPalIdentity {
  if (override) return override;
  let client = cache.get(config);
  if (!client) {
    client =
      config.PAYPAL_MODE === 'stub'
        ? new StubPayPalIdentity({ clientId: config.PAYPAL_CLIENT_ID })
        : new RestPayPalIdentity({
            apiBase: config.PAYPAL_API_BASE,
            clientId: config.PAYPAL_CLIENT_ID,
            clientSecret: config.PAYPAL_CLIENT_SECRET,
          });
    cache.set(config, client);
  }
  return client;
}

/** Tests: use `client` for every sign-in (`undefined` restores the config's client). */
export function setPayPalIdentity(client: PayPalIdentity | undefined): void {
  override = client;
}

// --- The state cookie --------------------------------------------------------------------------

export const LIPP_COOKIE = 'spg_lipp';
export const LIPP_COOKIE_PATH = '/api/auth/paypal';
export const LIPP_TTL_MS = 10 * 60 * 1000;

/** What `/start` remembers for `/callback`. */
export interface LippState {
  state: string;
  nonce: string;
  /** The publisher signed in at `/start` (Connect with PayPal links to it), else null. */
  link: string | null;
  /** Expiry, epoch ms. */
  exp: number;
}

function stateMac(secret: string, body: string): Buffer {
  const key = createHmac('sha256', secret).update('spigot:lipp-state').digest();
  return createHmac('sha256', key).update(body).digest();
}

export function newLippState(link: string | null, now: number = Date.now()): LippState {
  return {
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    link,
    exp: now + LIPP_TTL_MS,
  };
}

/** `payload.signature`; the payload holds no secret beyond the state and nonce themselves. */
export function signLippState(secret: string, s: LippState): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${stateMac(secret, body).toString('base64url')}`;
}

/** The state, or null when missing, malformed, forged or expired. */
export function openLippState(
  secret: string,
  token: string | undefined,
  now: number = Date.now(),
): LippState | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = stateMac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<LippState>;
    if (
      typeof v.state !== 'string' ||
      typeof v.nonce !== 'string' ||
      typeof v.exp !== 'number' ||
      (v.link !== null && typeof v.link !== 'string') ||
      v.exp <= now
    ) {
      return null;
    }
    return { state: v.state, nonce: v.nonce, link: v.link, exp: v.exp };
  } catch {
    return null;
  }
}

/** Constant-time compare for `state` and `nonce`. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
