import { FakePayPal } from './fake/core.js';
import { paypalContract } from './test-harness.js';

paypalContract('FakePayPal (PAYPAL_MODE=stub)', () => {
  const fake = new FakePayPal({ latencyMs: 1 });
  return {
    client: fake.client(),
    fail503: (op) => fake.failNext(op, { kind: 'status', http: 503 }),
    approve: (orderId) => fake.approve(orderId),
    mockResponses: true,
    timeoutMs: 5_000,
  };
});
