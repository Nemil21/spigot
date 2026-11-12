import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PayPalRestClient } from './client.js';
import type { TestCard } from './types.js';

/**
 * The PayPal contract suite: the same assertions against `FakePayPal` (CI) and the sandbox
 * (locally, `PAYPAL_MODE=sandbox npx vitest run apps/api/src/paypal/sandbox.contract.test.ts`).
 * Cases that need a buyer to approve in a browser run only where `approve` exists (the fake).
 */
export interface ContractEnv {
  client: PayPalRestClient;
  /** Answer 503 to the next matching call without sending it (see `faultyFetch`). */
  fail503(op: FaultOp): void;
  /** Buyer approval for a wallet / no-source order. Only the fake can do this unattended. */
  approve?: (orderId: string) => void;
  /** Mock declines reach PayPal (sandbox with mocks allowed, or the fake). */
  mockResponses: boolean;
  /** Per-case timeout. */
  timeoutMs: number;
}

export type FaultOp = 'order_create' | 'capture';

/**
 * PayPal's published sandbox test cards (Holdfast S7 step 6), re-checked with CAPTURE intent on
 * Nov 12 2026. Not real cards. Never 5105…5100. Discover 6011…1117 worked for S7's AUTHORIZE holds
 * but a CAPTURE-intent create refuses it (`422 CREDIT_CARD_NUMBER_MUST_BE_TEST_NUMBER`), so it is
 * left out.
 */
export const CONTRACT_CARDS: TestCard[] = [
  { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Contract Visa' },
  { number: '4012888888881881', expiry: '2030-11', security_code: '123', name: 'Contract Visa B' },
  { number: '5555555555554444', expiry: '2030-10', security_code: '123', name: 'Contract MC' },
  { number: '371449635398431', expiry: '2030-09', security_code: '1234', name: 'Contract Amex' },
];

/**
 * A `fetch` wrapper that answers 503 for the next matching call without sending it, so the sandbox
 * can run the TRANSIENT case without needing PayPal to fail.
 */
export function faultyFetch(inner: typeof fetch): {
  fetch: typeof fetch;
  fail503(op: FaultOp): void;
} {
  const pending: FaultOp[] = [];
  const opOf = (method: string, url: string): FaultOp | null => {
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/v2/checkout/orders') return 'order_create';
    if (method === 'POST' && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path))
      return 'capture';
    return null;
  };
  return {
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const op = opOf((init?.method ?? 'GET').toUpperCase(), url);
      const i = op ? pending.indexOf(op) : -1;
      if (i >= 0) {
        pending.splice(i, 1);
        return new Response(JSON.stringify({ name: 'SERVICE_UNAVAILABLE' }), { status: 503 });
      }
      return inner(input, init);
    },
    fail503: (op) => {
      pending.push(op);
    },
  };
}

const WALLET = {
  kind: 'wallet' as const,
  returnUrl: 'https://example.com/buyers/topup/return',
  cancelUrl: 'https://example.com/buyers/topup/cancel',
  brandName: 'Spigot',
};

export function paypalContract(name: string, setup: () => ContractEnv): void {
  describe(`PayPal contract: ${name}`, () => {
    const env = setup();
    const { client } = env;
    const opts = { timeout: env.timeoutMs };
    let card = 0;
    const nextCard = () => CONTRACT_CARDS[card++ % CONTRACT_CARDS.length]!;

    /** A SIM card top-up: captured at create, card vaulted. */
    async function cardTopup(amountCents = 2000) {
      const topupId = randomUUID();
      const r = await client.createTopupOrder({
        topupId,
        amountCents,
        source: { kind: 'card', card: nextCard() },
      });
      expect(r.status, JSON.stringify(r)).toBe('COMPLETED');
      if (r.status !== 'COMPLETED') throw new Error('card top-up did not complete');
      return { ...r, topupId };
    }

    it('card top-up captures at create: capture id, fee, custom_id, card vault', opts, async () => {
      const r = await cardTopup(2000);
      expect(r).toMatchObject({
        status: 'COMPLETED',
        orderId: expect.any(String),
        captureId: expect.any(String),
        amountCents: 2000,
        customId: r.topupId,
        reconciled: false,
        vault: { id: expect.any(String), kind: 'card' },
      });
      expect(r.feeCents).toEqual(expect.any(Number));
      expect(r.feeCents).toBeGreaterThan(0);

      const order = await client.getOrder(r.orderId);
      expect(order).toMatchObject({
        id: r.orderId,
        status: 'COMPLETED',
        intent: 'CAPTURE',
        amountCents: 2000,
        customId: r.topupId,
      });
      expect(order.captures[0]).toMatchObject({ id: r.captureId, status: 'COMPLETED' });
    });

    it(
      'vault_id (MIT) top-up captures; same request id → same order and capture (200)',
      opts,
      async () => {
        const first = await cardTopup(2500);
        const vaultId = first.vault!.id;
        const topupId = randomUUID();
        const input = {
          topupId,
          amountCents: 1500,
          source: { kind: 'card_vault' as const, vaultId },
        };
        const one = await client.createTopupOrder(input);
        expect(one, JSON.stringify(one)).toMatchObject({ status: 'COMPLETED', amountCents: 1500 });
        const two = await client.createTopupOrder(input);
        expect(two).toMatchObject({ status: 'COMPLETED', orderId: one.orderId });
        if (one.status === 'COMPLETED' && two.status === 'COMPLETED') {
          expect(two.captureId).toBe(one.captureId);
        }
      },
    );

    it(
      'no-source order → AWAITING_APPROVAL; same request id → same order (200)',
      opts,
      async () => {
        const topupId = randomUUID();
        const one = await client.createTopupOrder({
          topupId,
          amountCents: 1000,
          source: { kind: 'none' },
        });
        expect(one).toMatchObject({
          status: 'AWAITING_APPROVAL',
          orderStatus: 'CREATED',
          approveUrl: expect.stringMatching(/^https:\/\//),
        });
        const two = await client.createTopupOrder({
          topupId,
          amountCents: 1000,
          source: { kind: 'none' },
        });
        expect(two).toMatchObject({ status: 'AWAITING_APPROVAL', orderId: one.orderId });
      },
    );

    it(
      'raw-card create replayed with the same id → never DECLINED, never a second order',
      opts,
      async () => {
        // Sandbox, CAPTURE intent (Nov 12 2026): the replay returns the same order and capture
        // (200). Holdfast S7 (AUTHORIZE) saw 422 TRANSACTION_REFUSED instead, which the client
        // surfaces as NEEDS_RECONCILE; both are accepted, a decline or a new order is not.
        const first = await cardTopup(1200);
        const again = await client.createTopupOrder({
          topupId: first.topupId,
          amountCents: 1200,
          source: { kind: 'card', card: CONTRACT_CARDS[0]! },
        });
        if (again.status === 'COMPLETED') {
          expect(again).toMatchObject({ orderId: first.orderId, captureId: first.captureId });
        } else {
          expect(again).toMatchObject({
            status: 'NEEDS_RECONCILE',
            errorClass: 'RECONCILE',
            code: 'TRANSACTION_REFUSED',
            http: 422,
          });
        }
      },
    );

    it('wallet order → AWAITING_APPROVAL with the payer-action link', opts, async () => {
      const r = await client.createTopupOrder({
        topupId: randomUUID(),
        amountCents: 2000,
        source: WALLET,
      });
      expect(r).toMatchObject({
        status: 'AWAITING_APPROVAL',
        orderStatus: 'PAYER_ACTION_REQUIRED',
        approveUrl: expect.stringMatching(/^https:\/\//),
      });
    });

    it('capture before approval → AWAITING_APPROVAL (not a decline)', opts, async () => {
      const topupId = randomUUID();
      const r = await client.createTopupOrder({ topupId, amountCents: 2000, source: WALLET });
      expect(r.status).toBe('AWAITING_APPROVAL');
      const cap = await client.captureOrder(r.orderId!, topupId);
      expect(cap, JSON.stringify(cap)).toMatchObject({
        status: 'AWAITING_APPROVAL',
        orderId: r.orderId,
        orderStatus: 'PAYER_ACTION_REQUIRED',
      });
    });

    it('a 503 on create is retried with the same id → one order', opts, async () => {
      const first = await cardTopup(1100);
      const topupId = randomUUID();
      env.fail503('order_create');
      const r = await client.createTopupOrder({
        topupId,
        amountCents: 900,
        source: { kind: 'card_vault', vaultId: first.vault!.id },
      });
      expect(r).toMatchObject({ status: 'COMPLETED', amountCents: 900, customId: topupId });
    });

    it.runIf(env.mockResponses)(
      'mock INSTRUMENT_DECLINED on a vault charge → DECLINED (TERMINAL)',
      opts,
      async () => {
        const first = await cardTopup(1300);
        const r = await client.createTopupOrder({
          topupId: randomUUID(),
          amountCents: 1300,
          source: { kind: 'card_vault', vaultId: first.vault!.id },
          mockResponse: 'INSTRUMENT_DECLINED',
        });
        expect(r, JSON.stringify(r)).toMatchObject({ status: 'DECLINED', errorClass: 'TERMINAL' });
      },
    );

    describe.runIf(!!env.approve)('after buyer approval', () => {
      async function approvedWallet(vault = false) {
        const topupId = randomUUID();
        const r = await client.createTopupOrder({
          topupId,
          amountCents: 2000,
          source: { ...WALLET, vault },
        });
        expect(r.status).toBe('AWAITING_APPROVAL');
        env.approve!(r.orderId!);
        return { orderId: r.orderId!, topupId };
      }

      it(
        'wallet approve → capture → COMPLETED with fee; wallet vault when asked',
        opts,
        async () => {
          const { orderId, topupId } = await approvedWallet(true);
          const cap = await client.captureOrder(orderId, topupId);
          expect(cap).toMatchObject({
            status: 'COMPLETED',
            orderId,
            captureId: expect.any(String),
            amountCents: 2000,
            customId: topupId,
            reconciled: false,
            vault: { id: expect.any(String), kind: 'paypal' },
          });
          if (cap.status === 'COMPLETED') expect(cap.feeCents).toBeGreaterThan(0);
        },
      );

      it('capture replay with the same capture:<topupId> → same capture id', opts, async () => {
        const { orderId, topupId } = await approvedWallet();
        const one = await client.captureOrder(orderId, topupId);
        const two = await client.captureOrder(orderId, topupId);
        expect(one.status).toBe('COMPLETED');
        expect(two).toMatchObject({ status: 'COMPLETED', reconciled: false });
        if (one.status === 'COMPLETED' && two.status === 'COMPLETED') {
          expect(two.captureId).toBe(one.captureId);
        }
      });

      it(
        'capture with a different id after capture → 422 → RECONCILE → COMPLETED, original id',
        opts,
        async () => {
          const { orderId, topupId } = await approvedWallet();
          const one = await client.captureOrder(orderId, topupId);
          const two = await client.captureOrder(orderId, `${topupId}-other`);
          expect(two).toMatchObject({ status: 'COMPLETED', reconciled: true });
          if (one.status === 'COMPLETED' && two.status === 'COMPLETED') {
            expect(two.captureId).toBe(one.captureId);
          }
        },
      );

      it('a 503 on capture is retried with the same id → one capture', opts, async () => {
        const { orderId, topupId } = await approvedWallet();
        env.fail503('capture');
        const cap = await client.captureOrder(orderId, topupId);
        expect(cap).toMatchObject({ status: 'COMPLETED' });
        const order = await client.getOrder(orderId);
        expect(order.captures).toHaveLength(1);
      });

      it.runIf(env.mockResponses)(
        'mock INSTRUMENT_DECLINED on capture (403, empty body) → DECLINED (TERMINAL)',
        opts,
        async () => {
          const { orderId, topupId } = await approvedWallet();
          const cap = await client.captureOrder(orderId, topupId, {
            mockResponse: 'INSTRUMENT_DECLINED',
          });
          expect(cap).toMatchObject({
            status: 'DECLINED',
            errorClass: 'TERMINAL',
            http: 403,
            orderId,
          });
        },
      );
    });
  });
}
