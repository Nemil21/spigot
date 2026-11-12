import { describe, expect, it } from 'vitest';
import { MissingFeatureConfigError } from '../config.js';
import { FakePayPalExtras } from './fake/extras.js';
import { FAKE_WEBHOOK_ID, topLevelValueText } from './fake/webhooks.js';
import { verifyRequestBody, verifyWebhook } from './webhooks.js';

const CAPTURE = { id: 'CAP1', status: 'COMPLETED', custom_id: 'topup-1' };

function setup() {
  const fake = new FakePayPalExtras();
  return { fake, http: fake.transport() };
}

describe('pp.verifyWebhook (raw body)', () => {
  it('a delivery verified from its raw body passes', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    expect(d.event).toMatchObject({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      resource: CAPTURE,
    });
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, d.rawBody)).resolves.toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'verify_webhook', requestId: null, http: 200 });
  });

  it('the same payload re-serialised with different spacing fails, as in the sandbox', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_item_id: 'I1' });
    const respaced = JSON.stringify(JSON.parse(d.rawBody), null, 2);
    expect(respaced).not.toBe(d.rawBody);
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, respaced)).resolves.toBe(false);

    // And the other way round: a spaced delivery, compacted by JSON.stringify(JSON.parse(…)).
    const spaced = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE, { spacing: 1 });
    await expect(
      verifyWebhook(http, FAKE_WEBHOOK_ID, spaced.headers, spaced.rawBody),
    ).resolves.toBe(true);
    const compacted = JSON.stringify(JSON.parse(spaced.rawBody));
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, spaced.headers, compacted)).resolves.toBe(
      false,
    );
  });

  it('a tampered body, another delivery’s signature or a different webhook id fail', async () => {
    const { fake, http } = setup();
    const a = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    const b = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', { ...CAPTURE, id: 'CAP2' });
    const tampered = a.rawBody.replace('topup-1', 'topup-2');
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, a.headers, tampered)).resolves.toBe(false);
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, b.headers, a.rawBody)).resolves.toBe(false);
    await expect(verifyWebhook(http, 'OTHERWEBHOOK', a.headers, a.rawBody)).resolves.toBe(false);
  });

  it('missing signature headers or a non-object body → false without calling PayPal', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    const { 'paypal-transmission-id': _id, ...noId } = d.headers;
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, noId, d.rawBody)).resolves.toBe(false);
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, 'not json')).resolves.toBe(false);
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, '[1]')).resolves.toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts headers in any case and as arrays (Node / Fastify shapes)', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('CHECKOUT.ORDER.APPROVED', { id: 'ORD1' });
    const shouty = Object.fromEntries(
      Object.entries(d.headers).map(([k, v]) => [k.toUpperCase(), [v]]),
    );
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, shouty, d.rawBody)).resolves.toBe(true);
  });

  it('PAYPAL_WEBHOOK_ID unset or not alphanumeric → MissingFeatureConfigError', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    await expect(verifyWebhook(http, undefined, d.headers, d.rawBody)).rejects.toBeInstanceOf(
      MissingFeatureConfigError,
    );
    await expect(verifyWebhook(http, 'WH-123', d.headers, d.rawBody)).rejects.toBeInstanceOf(
      MissingFeatureConfigError,
    );
  });

  it('PayPal down → throws TRANSIENT (the route answers 5xx so PayPal redelivers); 4xx → false', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    fake.failNext('verify_webhook', { kind: 'status', http: 503 });
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, d.rawBody)).rejects.toMatchObject({
      errorClass: 'TRANSIENT',
      call: 'verify_webhook',
    });
    fake.failNext('verify_webhook', {
      kind: 'status',
      http: 400,
      body: { name: 'INVALID_REQUEST' },
    });
    await expect(verifyWebhook(http, FAKE_WEBHOOK_ID, d.headers, d.rawBody)).resolves.toBe(false);
  });

  it('the fake rejects a non-alphanumeric webhook_id with 400 INVALID_REQUEST (S11)', async () => {
    const { fake, http } = setup();
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', CAPTURE);
    const res = await http.request(
      'verify_webhook',
      'POST',
      '/v1/notifications/verify-webhook-signature',
      {
        rawBody: verifyRequestBody(
          {
            auth_algo: d.headers['paypal-auth-algo']!,
            cert_url: d.headers['paypal-cert-url']!,
            transmission_id: d.headers['paypal-transmission-id']!,
            transmission_sig: d.headers['paypal-transmission-sig']!,
            transmission_time: d.headers['paypal-transmission-time']!,
          },
          'WH-123',
          d.rawBody,
        ),
      },
    );
    expect(res.http).toBe(400);
    expect(res.json.name).toBe('INVALID_REQUEST');
  });
});

describe('verifyRequestBody / topLevelValueText', () => {
  it('embeds the raw event byte for byte and the fake reads it back exactly', () => {
    const raw =
      '{ "id" : "WH-1",\n  "resource": {"note": "a \\"quoted\\" } brace", "n": [1, 2.50]} }';
    const body = verifyRequestBody(
      {
        auth_algo: 'a',
        cert_url: 'c',
        transmission_id: 'i',
        transmission_sig: 's',
        transmission_time: 't',
      },
      'WEBHOOK1',
      raw,
    );
    expect(JSON.parse(body)).toMatchObject({
      webhook_id: 'WEBHOOK1',
      webhook_event: { id: 'WH-1' },
    });
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(topLevelValueText(body, 'webhook_event')).toBe(raw);
    expect(topLevelValueText(body, 'webhook_id')).toBe('"WEBHOOK1"');
    expect(topLevelValueText(body, 'missing')).toBeNull();
    expect(topLevelValueText('[1]', 'x')).toBeNull();
  });
});
