import { describe, expect, it } from 'vitest';
import { PayPalRestClient } from './client.js';
import { PayPalApiError } from './errors.js';
import { captureRequestId, paymentSourceBody, readOrder, topupResultOf } from './orders.js';

const capture = (status: string, extra: Record<string, unknown> = {}) => ({
  id: `CAP-${status}`,
  status,
  amount: { currency_code: 'USD', value: '20.00' },
  custom_id: 'tp-1',
  seller_receivable_breakdown: {
    gross_amount: { currency_code: 'USD', value: '20.00' },
    paypal_fee: { currency_code: 'USD', value: '1.19' },
    net_amount: { currency_code: 'USD', value: '18.81' },
  },
  ...extra,
});

const order = (status: string, captures: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id: 'ORD-1',
  intent: 'CAPTURE',
  status,
  purchase_units: [
    {
      custom_id: 'tp-1',
      amount: { currency_code: 'USD', value: '20.00' },
      ...(captures.length ? { payments: { captures } } : {}),
    },
  ],
  links: [
    { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD-1' },
    { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD-1' },
  ],
  ...extra,
});

describe('topupResultOf (normaliser)', () => {
  it('COMPLETED capture → COMPLETED with capture id, fee, vault, custom_id', () => {
    const raw = order('COMPLETED', [capture('COMPLETED')], {
      payment_source: {
        card: { attributes: { vault: { id: 'V1', status: 'VAULTED', customer: { id: 'C1' } } } },
      },
    });
    expect(topupResultOf(readOrder(raw))).toEqual({
      status: 'COMPLETED',
      orderId: 'ORD-1',
      captureId: 'CAP-COMPLETED',
      amountCents: 2000,
      feeCents: 119,
      vault: { id: 'V1', kind: 'card', customerId: 'C1' },
      customId: 'tp-1',
      reconciled: false,
    });
  });

  it('wallet vault (paypal source) is read too; a non-VAULTED vault is ignored', () => {
    const vaulted = order('COMPLETED', [capture('COMPLETED')], {
      payment_source: { paypal: { attributes: { vault: { id: 'W1', status: 'VAULTED' } } } },
    });
    expect(readOrder(vaulted).vault).toEqual({ id: 'W1', kind: 'paypal', customerId: null });
    const approved = order('COMPLETED', [capture('COMPLETED')], {
      payment_source: { paypal: { attributes: { vault: { id: 'W1', status: 'APPROVED' } } } },
    });
    expect(readOrder(approved).vault).toBeNull();
  });

  it('PENDING capture → PENDING with the reason', () => {
    const raw = order('COMPLETED', [
      capture('PENDING', { status_details: { reason: 'PENDING_REVIEW' } }),
    ]);
    expect(topupResultOf(readOrder(raw))).toMatchObject({
      status: 'PENDING',
      captureId: 'CAP-PENDING',
      reason: 'PENDING_REVIEW',
    });
  });

  it('DECLINED / FAILED capture → DECLINED (TERMINAL)', () => {
    for (const s of ['DECLINED', 'FAILED']) {
      expect(topupResultOf(readOrder(order('COMPLETED', [capture(s)])))).toMatchObject({
        status: 'DECLINED',
        captureId: `CAP-${s}`,
        code: `CAPTURE_${s}`,
        errorClass: 'TERMINAL',
      });
    }
  });

  it('a completed capture wins over a declined one; refunded captures still count as captured', () => {
    const raw = order('COMPLETED', [capture('DECLINED'), capture('PARTIALLY_REFUNDED')]);
    expect(topupResultOf(readOrder(raw))).toMatchObject({
      status: 'COMPLETED',
      captureId: 'CAP-PARTIALLY_REFUNDED',
    });
  });

  it('no capture, buyer still to act → AWAITING_APPROVAL with the payer-action link', () => {
    for (const s of ['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'SAVED']) {
      expect(topupResultOf(readOrder(order(s)))).toEqual({
        status: 'AWAITING_APPROVAL',
        orderId: 'ORD-1',
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD-1',
        orderStatus: s,
      });
    }
  });

  it('falls back to rel=approve; VOIDED → DECLINED; odd states and missing ids → NEEDS_RECONCILE', () => {
    const approve = order('CREATED', [], {
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=X' }],
    });
    expect(readOrder(approve).approveUrl).toBe(
      'https://www.sandbox.paypal.com/checkoutnow?token=X',
    );
    expect(topupResultOf(readOrder(order('VOIDED')))).toMatchObject({
      status: 'DECLINED',
      code: 'ORDER_VOIDED',
    });
    expect(topupResultOf(readOrder(order('COMPLETED')))).toMatchObject({
      status: 'NEEDS_RECONCILE',
      errorClass: 'RECONCILE',
      code: 'ORDER_COMPLETED',
    });
    expect(topupResultOf(readOrder({}))).toMatchObject({
      status: 'NEEDS_RECONCILE',
      code: 'MALFORMED_RESPONSE',
    });
  });
});

describe('paymentSourceBody', () => {
  it('builds the four api.md sources (+ none)', () => {
    expect(paymentSourceBody({ kind: 'none' })).toBeUndefined();
    expect(paymentSourceBody({ kind: 'card_vault', vaultId: 'V1' })).toEqual({
      card: {
        vault_id: 'V1',
        stored_credential: {
          payment_initiator: 'MERCHANT',
          payment_type: 'UNSCHEDULED',
          usage: 'SUBSEQUENT',
        },
      },
    });
    expect(paymentSourceBody({ kind: 'wallet_vault', vaultId: 'W1' })).toEqual({
      paypal: { vault_id: 'W1' },
    });
    const card = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'A' };
    expect(paymentSourceBody({ kind: 'card', card })).toEqual({
      card: { ...card, attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } },
    });
    expect(paymentSourceBody({ kind: 'card', card, vault: false })).toEqual({ card });
    const wallet = paymentSourceBody({ kind: 'wallet', returnUrl: 'r', cancelUrl: 'c' });
    expect(wallet).toEqual({
      paypal: {
        experience_context: {
          return_url: 'r',
          cancel_url: 'c',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    });
  });

  it('capture request id is capture:<topupId>', () => {
    expect(captureRequestId('tp-1')).toBe('capture:tp-1');
    expect(() => captureRequestId('')).toThrow(TypeError);
  });
});

/** A sandbox-base client whose PayPal answers come from `routes`. */
function clientWith(routes: (method: string, path: string) => Response) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 't', expires_in: 3600 });
    calls.push(`${method} ${path}`);
    return routes(method, path);
  };
  const client = new PayPalRestClient({
    baseUrl: 'https://api-m.sandbox.paypal.com',
    clientId: 'a',
    clientSecret: 'b',
    fetch,
    retries: 0,
    sleep: async () => {},
  });
  return { client, calls };
}

const err = (status: number, issue: string) =>
  Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue }] }, { status });

describe('captureOrder failure mapping (S7 §RECONCILE)', () => {
  it('403 with an EMPTY body (mock INSTRUMENT_DECLINED) → GET shows no capture → DECLINED TERMINAL', async () => {
    const { client, calls } = clientWith((m) =>
      m === 'POST' ? new Response(null, { status: 403 }) : Response.json(order('APPROVED')),
    );
    const r = await client.captureOrder('ORD-1', 'tp-1');
    expect(r).toEqual({
      status: 'DECLINED',
      orderId: 'ORD-1',
      captureId: null,
      code: 'HTTP_403',
      http: 403,
      errorClass: 'TERMINAL',
    });
    expect(calls).toEqual([
      'POST /v2/checkout/orders/ORD-1/capture',
      'GET /v2/checkout/orders/ORD-1',
    ]);
  });

  it('422 INSTRUMENT_DECLINED → DECLINED TERMINAL', async () => {
    const { client } = clientWith((m) =>
      m === 'POST' ? err(422, 'INSTRUMENT_DECLINED') : Response.json(order('APPROVED')),
    );
    expect(await client.captureOrder('ORD-1', 'tp-1')).toMatchObject({
      status: 'DECLINED',
      code: 'INSTRUMENT_DECLINED',
      errorClass: 'TERMINAL',
    });
  });

  it('422 ORDER_ALREADY_CAPTURED → GET → COMPLETED reconciled with the original capture id', async () => {
    const { client } = clientWith((m) =>
      m === 'POST'
        ? err(422, 'ORDER_ALREADY_CAPTURED')
        : Response.json(order('COMPLETED', [capture('COMPLETED')])),
    );
    expect(await client.captureOrder('ORD-1', 'tp-1')).toMatchObject({
      status: 'COMPLETED',
      captureId: 'CAP-COMPLETED',
      reconciled: true,
    });
  });

  it('422 then the GET fails with 5xx → NEEDS_RECONCILE (TRANSIENT), never DECLINED', async () => {
    const { client } = clientWith((m) =>
      m === 'POST' ? err(422, 'ORDER_ALREADY_CAPTURED') : new Response('', { status: 503 }),
    );
    expect(await client.captureOrder('ORD-1', 'tp-1')).toMatchObject({
      status: 'NEEDS_RECONCILE',
      errorClass: 'TRANSIENT',
      code: 'ORDER_ALREADY_CAPTURED',
    });
  });

  it('404 on capture and on GET → DECLINED', async () => {
    const { client } = clientWith(() => err(404, 'INVALID_RESOURCE_ID'));
    expect(await client.captureOrder('nope', 'tp-1')).toMatchObject({
      status: 'DECLINED',
      http: 404,
    });
  });

  it('a 200 capture whose capture is DECLINED → DECLINED (judged by the body)', async () => {
    const { client } = clientWith(() => Response.json(order('COMPLETED', [capture('DECLINED')])));
    expect(await client.captureOrder('ORD-1', 'tp-1')).toMatchObject({
      status: 'DECLINED',
      code: 'CAPTURE_DECLINED',
    });
  });
});

describe('createTopupOrder failure mapping', () => {
  it('403 with an empty body on create → DECLINED TERMINAL (classified by status)', async () => {
    const { client } = clientWith(() => new Response(null, { status: 403 }));
    expect(
      await client.createTopupOrder({
        topupId: 't',
        amountCents: 500,
        source: { kind: 'card_vault', vaultId: 'V' },
      }),
    ).toMatchObject({ status: 'DECLINED', errorClass: 'TERMINAL', http: 403 });
  });

  it('TRANSACTION_REFUSED on a vault charge is a real decline; on a raw card it is RECONCILE', async () => {
    const { client } = clientWith(() => err(422, 'TRANSACTION_REFUSED'));
    expect(
      await client.createTopupOrder({
        topupId: 't',
        amountCents: 500,
        source: { kind: 'card_vault', vaultId: 'V' },
      }),
    ).toMatchObject({ status: 'DECLINED', code: 'TRANSACTION_REFUSED' });
  });

  it('rejects bad amounts and empty ids before calling PayPal', async () => {
    const { client, calls } = clientWith(() => Response.json({}));
    await expect(
      client.createTopupOrder({ topupId: 't', amountCents: 0, source: { kind: 'none' } }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.createTopupOrder({ topupId: 't', amountCents: 1.5, source: { kind: 'none' } }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.createTopupOrder({ topupId: '', amountCents: 100, source: { kind: 'none' } }),
    ).rejects.toThrow(TypeError);
    expect(calls).toEqual([]);
  });
});

describe('getOrder', () => {
  it('throws a typed PayPalApiError on failure', async () => {
    const { client } = clientWith(() => err(404, 'INVALID_RESOURCE_ID'));
    const e = await client.getOrder('nope').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PayPalApiError);
    expect(e).toMatchObject({
      call: 'get',
      http: 404,
      errorClass: 'TERMINAL',
      code: 'INVALID_RESOURCE_ID',
    });
  });
});
