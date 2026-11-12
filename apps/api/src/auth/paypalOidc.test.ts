import { describe, expect, it } from 'vitest';
import {
  checkIdToken,
  identityFromUserinfo,
  newLippState,
  openLippState,
  RestPayPalIdentity,
  signLippState,
  StubOidcProvider,
  StubPayPalIdentity,
  STUB_OIDC_BASE,
  type PayPalLoginIdentity,
} from './paypalOidc.js';

/** SP-058 Log in with PayPal: the OIDC client, the stub provider and the state cookie. */

const SECRET = 'q'.repeat(40);
const CLIENT_SECRET = 'test-client-secret-NEVER-IN-BROWSER';

const jwt = (claims: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('RestPayPalIdentity (SP-058)', () => {
  it('authorize URL: sandbox consent host, scopes, state, nonce, redirect; never the secret', () => {
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com',
      clientId: 'cid',
      clientSecret: CLIENT_SECRET,
    });
    const url = new URL(
      client.authorizeUrl({ state: 'st4te', nonce: 'n0nce', redirectUri: 'http://x/cb' }),
    );
    expect(url.origin + url.pathname).toBe('https://www.sandbox.paypal.com/signin/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid',
      response_type: 'code',
      scope: 'openid email https://uri.paypal.com/services/paypalattributes',
      state: 'st4te',
      nonce: 'n0nce',
      redirect_uri: 'http://x/cb',
    });
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    const live = new RestPayPalIdentity({
      apiBase: 'https://api-m.paypal.com',
      clientId: 'cid',
      clientSecret: 'x',
    });
    expect(live.authorizeUrl({ state: 's', nonce: 'n', redirectUri: 'https://x/cb' })).toMatch(
      /^https:\/\/www\.paypal\.com\/signin\/authorize\?/,
    );
  });

  it('exchange: authorization_code with Basic auth, nonce-checked id_token, paypalv1.1 userinfo', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) {
        return Response.json({ access_token: 'AT-1', id_token: jwt({ nonce: 'N1', aud: 'cid' }) });
      }
      return Response.json({
        payer_id: 'PAYER123',
        name: 'Ada Publisher',
        emails: [
          { value: 'old@example.com', primary: false, confirmed: true },
          { value: 'Ada@Pub.Example', primary: true, confirmed: true },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com/',
      clientId: 'cid',
      clientSecret: 'sec',
      fetch: fetchMock,
    });
    await expect(client.exchange('the-code', 'N1')).resolves.toEqual({
      email: 'ada@pub.example',
      emailVerified: true,
      payerId: 'PAYER123',
      name: 'Ada Publisher',
    });
    expect(calls[0]!.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('cid:sec').toString('base64')}`,
    );
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(calls[1]!.url).toBe(
      'https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1',
    );
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer AT-1');

    // A token minted for another login's nonce is refused before userinfo is read.
    calls.length = 0;
    await expect(client.exchange('the-code', 'OTHER')).rejects.toMatchObject({
      stage: 'id_token',
      code: 'NONCE_MISMATCH',
    });
    expect(calls).toHaveLength(1);
  });

  it('exchange failure surfaces only PayPal’s error code', async () => {
    const client = new RestPayPalIdentity({
      apiBase: 'https://api-m.sandbox.paypal.com',
      clientId: 'cid',
      clientSecret: 'sec',
      fetch: (async () =>
        Response.json(
          { error: 'invalid_grant', error_description: 'code used' },
          { status: 400 },
        )) as unknown as typeof fetch,
    });
    const err = await client.exchange('c', 'n').catch((e: unknown) => e);
    expect(err).toMatchObject({ stage: 'token', http: 400, code: 'invalid_grant' });
    expect(String(err)).not.toContain('code used');
  });
});

describe('id_token and userinfo parsing (SP-058)', () => {
  it('checkIdToken: absent passes; wrong nonce, wrong aud or garbage fails', () => {
    expect(() => checkIdToken(undefined, 'n', 'cid')).not.toThrow();
    expect(() => checkIdToken(jwt({ nonce: 'n', aud: 'cid' }), 'n', 'cid')).not.toThrow();
    expect(() => checkIdToken(jwt({ nonce: 'n', aud: ['x', 'cid'] }), 'n', 'cid')).not.toThrow();
    expect(() => checkIdToken(jwt({ nonce: 'm', aud: 'cid' }), 'n', 'cid')).toThrow(/NONCE/);
    expect(() => checkIdToken(jwt({ aud: 'cid' }), 'n', 'cid')).toThrow(/NONCE/);
    expect(() => checkIdToken(jwt({ nonce: 'n', aud: 'evil' }), 'n', 'cid')).toThrow(/AUDIENCE/);
    expect(() => checkIdToken('not-a-jwt', 'n', 'cid')).toThrow(/MALFORMED/);
  });

  it('userinfo: OIDC email_verified wins; unconfirmed paypalv1.1 email is unverified', () => {
    expect(identityFromUserinfo({ email: 'A@b.co', email_verified: 'false' })).toMatchObject({
      email: 'a@b.co',
      emailVerified: false,
      payerId: null,
    });
    expect(
      identityFromUserinfo({ emails: [{ value: 'x@y.co', primary: true, confirmed: false }] }),
    ).toMatchObject({ email: 'x@y.co', emailVerified: false });
    expect(identityFromUserinfo({ payer_id: 'P' })).toBeNull();
  });
});

describe('stub OIDC provider (SP-058)', () => {
  const ada: PayPalLoginIdentity = {
    email: 'ada@pub.example',
    emailVerified: true,
    payerId: 'PAYER-ADA',
    name: 'Ada',
  };

  it('authorize comes straight back to the callback; the code works once, with its nonce', async () => {
    const stub = new StubPayPalIdentity({ clientId: 'cid', identity: ada });
    const url = new URL(
      stub.authorizeUrl({ state: 'S', nonce: 'N', redirectUri: 'http://localhost:3000/cb' }),
    );
    expect(url.origin + url.pathname).toBe('http://localhost:3000/cb');
    expect(url.searchParams.get('state')).toBe('S');
    const code = url.searchParams.get('code')!;
    await expect(stub.exchange(code, 'WRONG')).rejects.toMatchObject({ code: 'NONCE_MISMATCH' });

    const url2 = new URL(stub.authorizeUrl({ state: 'S', nonce: 'N', redirectUri: 'http://x/cb' }));
    const code2 = url2.searchParams.get('code')!;
    await expect(stub.exchange(code2, 'N')).resolves.toEqual(ada);
    await expect(stub.exchange(code2, 'N')).rejects.toMatchObject({
      stage: 'token',
      http: 400,
      code: 'invalid_grant',
    });
    expect(stub.provider.exchanged).toEqual([code, code2, code2]);
  });

  it('refuses the wrong client secret at the token endpoint', async () => {
    const provider = new StubOidcProvider('cid', 'right');
    const client = new RestPayPalIdentity({
      apiBase: STUB_OIDC_BASE,
      clientId: 'cid',
      clientSecret: 'wrong',
      fetch: provider.fetch,
    });
    await expect(client.exchange(provider.consent('n'), 'n')).rejects.toMatchObject({
      http: 401,
      code: 'invalid_client',
    });
  });
});

describe('state cookie (SP-058)', () => {
  it('round-trips; forged, re-keyed or expired cookies are null', () => {
    const st = newLippState('pub-1');
    const token = signLippState(SECRET, st);
    expect(openLippState(SECRET, token)).toEqual(st);
    expect(openLippState('z'.repeat(40), token)).toBeNull();
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...st, link: 'pub-2' })).toString('base64url');
    expect(openLippState(SECRET, `${forged}.${token.split('.')[1]}`)).toBeNull();
    expect(openLippState(SECRET, `${body}`)).toBeNull();
    expect(openLippState(SECRET, token, st.exp + 1)).toBeNull();
    expect(openLippState(SECRET, undefined)).toBeNull();
  });

  it('every start gets a fresh state and nonce', () => {
    const a = newLippState(null);
    const b = newLippState(null);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(a.nonce);
  });
});
