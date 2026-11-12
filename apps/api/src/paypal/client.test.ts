import { describe, expect, it } from 'vitest';
import { PayPalHttp, PayPalRestClient, redact, type PayPalLogEntry } from './client.js';
import { PayPalAuthError } from './errors.js';
import { FAKE_CLIENT_SECRET, FakePayPal } from './fake/core.js';
import type { TestCard } from './types.js';

const CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Unit Buyer',
};

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** A scripted `fetch`: token calls get a token; everything else gets `answer(n)`. */
function scripted(answer: (n: number, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  let tokens = 0;
  let n = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const s: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    seen.push(s);
    if (s.url.endsWith('/v1/oauth2/token')) {
      tokens++;
      return Response.json({ access_token: `tok-${tokens}`, expires_in: 3600 });
    }
    return answer(++n, s);
  };
  return { fetch, seen, tokens: () => tokens };
}

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const LIVE = 'https://api-m.paypal.com';

function restClient(
  fetch: typeof globalThis.fetch,
  extra: Partial<ConstructorParameters<typeof PayPalRestClient>[0]> = {},
) {
  return new PayPalRestClient({
    baseUrl: SANDBOX,
    clientId: 'id',
    clientSecret: 'shh-secret',
    fetch,
    sleep: async () => {},
    ...extra,
  });
}

describe('token cache', () => {
  it('fetches the token once for 20 concurrent calls', async () => {
    const fake = new FakePayPal({ latencyMs: 5 });
    const client = fake.client();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.createTopupOrder({ topupId: `t-${i}`, amountCents: 1000, source: { kind: 'none' } }),
      ),
    );
    expect(fake.tokensIssued).toBe(1);
    expect(fake.orders()).toHaveLength(20);
  });

  it('reuses the token until expires_in − 60 s, then refreshes', async () => {
    let now = 1_000_000;
    let issued = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith('/v1/oauth2/token')) {
        issued++;
        return Response.json({ access_token: `t${issued}`, expires_in: 120 });
      }
      return Response.json({});
    };
    const http = new PayPalHttp({
      baseUrl: SANDBOX,
      clientId: 'a',
      clientSecret: 'b',
      fetch,
      now: () => now,
    });
    expect(await http.token()).toBe('t1');
    now += 59_000;
    expect(await http.token()).toBe('t1');
    now += 1_000; // 60 s in: 120 s − 60 s skew reached
    expect(await http.token()).toBe('t2');
    expect(issued).toBe(2);
  });

  it('a 401 refreshes the token once and retries with the same request id', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    await client.createTopupOrder({ topupId: 'warm', amountCents: 500, source: { kind: 'none' } });
    fake.revokeTokens();
    const r = await client.createTopupOrder({
      topupId: 'after-401',
      amountCents: 500,
      source: { kind: 'none' },
    });
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(fake.tokensIssued).toBe(2);
    const creates = fake.calls.filter(
      (c) => c.op === 'order_create' && c.requestId === 'after-401',
    );
    expect(creates.map((c) => c.http)).toEqual([401, 201]);
  });

  it('bad credentials throw PayPalAuthError (configuration, not a payment outcome)', async () => {
    const fake = new FakePayPal();
    const client = fake.client({ clientSecret: 'wrong' });
    await expect(
      client.createTopupOrder({ topupId: 't', amountCents: 500, source: { kind: 'none' } }),
    ).rejects.toBeInstanceOf(PayPalAuthError);
  });
});

describe('request headers', () => {
  it('sends PayPal-Request-Id and Prefer: return=representation on every call', async () => {
    const fake = new FakePayPal();
    const client = fake.client();
    const r = await client.createTopupOrder({
      topupId: 'topup-1',
      amountCents: 1000,
      source: { kind: 'wallet', returnUrl: 'https://x/r', cancelUrl: 'https://x/c' },
    });
    fake.approve(r.orderId!);
    await client.captureOrder(r.orderId!, 'topup-1');
    await client.getOrder(r.orderId!);
    const [create, capture, get] = fake.calls.filter((c) => c.op !== 'token');
    expect(create).toMatchObject({ requestId: 'topup-1', prefer: 'return=representation' });
    expect(capture).toMatchObject({
      requestId: 'capture:topup-1',
      prefer: 'return=representation',
    });
    expect(get).toMatchObject({ prefer: 'return=representation' });
  });

  it('builds the CAPTURE order body api.md specifies', async () => {
    const s = scripted(() =>
      Response.json({ id: 'O1', status: 'PAYER_ACTION_REQUIRED' }, { status: 201 }),
    );
    await restClient(s.fetch).createTopupOrder({
      topupId: 'tp-9',
      amountCents: 2500,
      source: { kind: 'wallet', returnUrl: 'https://x/r', cancelUrl: 'https://x/c', vault: true },
    });
    const create = s.seen.find((x) => x.url.endsWith('/v2/checkout/orders'))!;
    expect(JSON.parse(create.body)).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: 'tp-9',
          description: 'Spigot balance top-up',
          amount: { currency_code: 'USD', value: '25.00' },
        },
      ],
      payment_source: {
        paypal: {
          attributes: {
            vault: {
              store_in_vault: 'ON_SUCCESS',
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
            },
          },
          experience_context: {
            return_url: 'https://x/r',
            cancel_url: 'https://x/c',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    });
    expect(create.headers.get('paypal-request-id')).toBe('tp-9');
  });
});

describe('timeouts and transient failures', () => {
  it('a timeout is NEEDS_RECONCILE (TRANSIENT) after the in-call retries', async () => {
    const fake = new FakePayPal();
    const client = fake.client({ timeoutMs: 30, retries: 1 });
    fake.failNext('order_create', { kind: 'timeout' }, 2);
    const r = await client.createTopupOrder({
      topupId: 'slow',
      amountCents: 500,
      source: { kind: 'none' },
    });
    expect(r).toMatchObject({
      status: 'NEEDS_RECONCILE',
      errorClass: 'TRANSIENT',
      code: 'TIMEOUT',
      http: 0,
    });
    expect(fake.orders()).toHaveLength(0);
  });

  it('a network error is NEEDS_RECONCILE (TRANSIENT), never thrown', async () => {
    const s = scripted(() => {
      throw new TypeError('fetch failed');
    });
    const r = await restClient(s.fetch, { retries: 0 }).captureOrder('O1', 'tp');
    expect(r).toMatchObject({
      status: 'NEEDS_RECONCILE',
      errorClass: 'TRANSIENT',
      code: 'NETWORK',
    });
  });

  it('token endpoint 5xx is TRANSIENT (no answer), not an auth error', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('', { status: 503 });
    const r = await restClient(fetch, { retries: 0 }).createTopupOrder({
      topupId: 't',
      amountCents: 500,
      source: { kind: 'none' },
    });
    expect(r).toMatchObject({ status: 'NEEDS_RECONCILE', errorClass: 'TRANSIENT' });
  });
});

describe('logging', () => {
  it('logs one line per call with ids and statuses, never tokens or secrets', async () => {
    const lines: PayPalLogEntry[] = [];
    const fake = new FakePayPal();
    const client = fake.client({ logger: (e) => lines.push(e) });
    await client.createTopupOrder({
      topupId: 'log-1',
      amountCents: 500,
      source: { kind: 'card', card: CARD },
    });
    expect(lines.map((l) => [l.call, l.http])).toEqual([
      ['token', 200],
      ['order_create', 201],
    ]);
    expect(lines[1]).toMatchObject({ requestId: 'log-1', debugId: expect.any(String), attempt: 1 });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('fake-token');
    expect(text).not.toContain(FAKE_CLIENT_SECRET);
    expect(text).not.toContain('4111111111111111');
  });

  it('a throwing logger never breaks a call', async () => {
    const client = new FakePayPal().client({
      logger: () => {
        throw new Error('boom');
      },
    });
    const r = await client.createTopupOrder({
      topupId: 'x',
      amountCents: 500,
      source: { kind: 'none' },
    });
    expect(r.status).toBe('AWAITING_APPROVAL');
  });

  it('redact scrubs bearer / basic tokens and secrets', () => {
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
    expect(redact('Basic Zm9vOmJhcg==')).toBe('Basic [redacted]');
    expect(redact('{"access_token":"A21AA"}')).toBe('{"access_token":"[redacted]"}');
    expect(redact('client_secret=xyz&a=1')).toBe('client_secret=[redacted]&a=1');
  });
});

describe('raw cards and mock responses never reach a live base', () => {
  const ok = () => Response.json({ id: 'O1', status: 'COMPLETED' }, { status: 201 });

  it('raw card is refused unless allowed, and always on a live base', async () => {
    const card = { topupId: 't', amountCents: 500, source: { kind: 'card' as const, card: CARD } };
    await expect(restClient(scripted(ok).fetch).createTopupOrder(card)).rejects.toThrow(/raw card/);
    await expect(
      restClient(scripted(ok).fetch, { baseUrl: LIVE, allowRawCard: true }).createTopupOrder(card),
    ).rejects.toThrow(/raw card/);
    await expect(
      restClient(scripted(ok).fetch, { allowRawCard: true }).createTopupOrder(card),
    ).resolves.toBeDefined();
  });

  it('PayPal-Mock-Response is sent only when allowed on a sandbox base', async () => {
    const input = {
      topupId: 't',
      amountCents: 500,
      source: { kind: 'card_vault' as const, vaultId: 'V1' },
      mockResponse: 'INSTRUMENT_DECLINED' as const,
    };
    const header = async (extra: Parameters<typeof restClient>[1]) => {
      const s = scripted(ok);
      await restClient(s.fetch, extra).createTopupOrder(input);
      return s.seen.find((x) => x.url.endsWith('/orders'))!.headers.get('paypal-mock-response');
    };
    expect(await header({})).toBeNull();
    expect(await header({ baseUrl: LIVE, allowMockResponse: true })).toBeNull();
    expect(await header({ allowMockResponse: true })).toBe(
      '{"mock_application_codes":"INSTRUMENT_DECLINED"}',
    );
  });
});
