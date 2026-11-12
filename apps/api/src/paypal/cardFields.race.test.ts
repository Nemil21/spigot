import { describe, expect, it } from 'vitest';
import { FakePayPal } from './fake/core.js';
import type { TopupResult } from './types.js';

/**
 * SP-063 card fields on FakePayPal: the order is created with a numberless card source (vault
 * ON_SUCCESS), the browser's `submit()` attaches the card (`fake.submitCardFields`), then capture.
 * Holdfast S7 step 3: a create without a raw card replays cleanly with the same request id.
 */

const CARD_FIELDS = {
  kind: 'card_fields' as const,
  returnUrl: 'https://x/topups/return',
  cancelUrl: 'https://x/topups/return?cancelled=1',
  vault: true,
};
let n = 0;
const uid = () => `topup-cf-${++n}`;

function racing() {
  const fake = new FakePayPal({ latencyMs: 2, jitterMs: 8 });
  return { fake, client: fake.client({ timeoutMs: 1_000 }) };
}

const orderIds = (rs: TopupResult[]) => new Set(rs.map((r) => ('orderId' in r ? r.orderId : null)));

describe('card-fields top-up (FakePayPal)', () => {
  it('double submit: 20 parallel creates with the same request id → one order, awaiting the card', async () => {
    const { fake, client } = racing();
    const topupId = uid();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createTopupOrder({ topupId, amountCents: 2000, source: CARD_FIELDS }),
      ),
    );
    expect(results.every((r) => r.status === 'AWAITING_APPROVAL')).toBe(true);
    expect(orderIds(results).size).toBe(1);
    expect(fake.orders()).toHaveLength(1);
    expect(fake.captures()).toHaveLength(0);
    // The request carried no card number: it is replay-safe, not a raw-card order.
    expect(fake.orders()[0]).toMatchObject({
      source: 'card',
      rawCard: false,
      vaultRequested: true,
    });
  });

  it('even in S7 refusal mode a numberless card create replays (only raw cards are refused)', async () => {
    const fake = new FakePayPal({ latencyMs: 2, jitterMs: 8, rawCardReplay: 'refuse' });
    const client = fake.client({ timeoutMs: 1_000 });
    const topupId = uid();
    const a = await client.createTopupOrder({ topupId, amountCents: 2000, source: CARD_FIELDS });
    const b = await client.createTopupOrder({ topupId, amountCents: 2000, source: CARD_FIELDS });
    expect(b).toEqual(a);
    expect(fake.orders()).toHaveLength(1);
  });

  it('capture before submit() → AWAITING_APPROVAL; after submit, 20 parallel captures → one capture, card vaulted as Visa ••1111', async () => {
    const { fake, client } = racing();
    const topupId = uid();
    const created = await client.createTopupOrder({
      topupId,
      amountCents: 2000,
      source: CARD_FIELDS,
    });
    const orderId = created.orderId!;
    expect((await client.captureOrder(orderId, topupId)).status).toBe('AWAITING_APPROVAL');

    fake.submitCardFields(orderId, '4111 1111 1111 1111');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.captureOrder(orderId, topupId)),
    );
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(new Set(results.map((r) => r.status === 'COMPLETED' && r.captureId)).size).toBe(1);
    expect(fake.captures(orderId)).toHaveLength(1);
    const done = results[0]!;
    expect(done.status === 'COMPLETED' && done.vault).toMatchObject({
      kind: 'card',
      id: expect.any(String),
      label: 'Visa ••1111',
    });
  });

  it('without vault the card is captured but not saved', async () => {
    const { fake, client } = racing();
    const topupId = uid();
    const created = await client.createTopupOrder({
      topupId,
      amountCents: 500,
      source: { ...CARD_FIELDS, vault: false },
    });
    fake.submitCardFields(created.orderId!, '5555555555554444');
    const done = await client.captureOrder(created.orderId!, topupId);
    expect(done.status === 'COMPLETED' && done.vault).toBeNull();
  });

  it('submitCardFields refuses wallet, raw-card and already-submitted orders', async () => {
    const { fake, client } = racing();
    const wallet = await client.createTopupOrder({
      topupId: uid(),
      amountCents: 500,
      source: { kind: 'wallet', returnUrl: 'r', cancelUrl: 'c' },
    });
    expect(() => fake.submitCardFields(wallet.orderId!)).toThrow(/not a card-fields order/);
    const cf = await client.createTopupOrder({
      topupId: uid(),
      amountCents: 500,
      source: CARD_FIELDS,
    });
    fake.submitCardFields(cf.orderId!);
    expect(() => fake.submitCardFields(cf.orderId!)).toThrow(/APPROVED/);
  });
});
