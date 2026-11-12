// Day-1 PayPal sandbox spikes for Holdfast (see docs/HOLDFAST.md §6).
// Usage: node spikes/paypal-spikes.mjs [s1|s2|s3|s4|all]
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from ../.env (git-ignored).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const BASE = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
// PayPal's published sandbox test card; not a real card.
const TEST_CARD = { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Spike Buyer' };

let token;
async function auth() {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status} (check PAYPAL_CLIENT_SECRET in .env)`);
  token = (await res.json()).access_token;
}

async function pp(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID(), // idempotency key
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, json };
}

const usd = (v) => ({ currency_code: 'USD', value: v.toFixed(2) });

// Card order with intent=AUTHORIZE: authorizes immediately, no buyer redirect.
async function hold(amount, paymentSource = { card: TEST_CARD }) {
  const r = await pp('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ amount: usd(amount), description: 'Holdfast spike bid' }],
    payment_source: paymentSource,
  });
  const authz = r.json.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authz) throw new Error(`hold failed ${r.status}: ${JSON.stringify(r.json).slice(0, 400)}`);
  return { orderId: r.json.id, authId: authz.id, status: authz.status, vault: r.json.payment_source?.card?.attributes?.vault };
}
const capture = (authId, amount, headers) =>
  pp('POST', `/v2/payments/authorizations/${authId}/capture`, { amount: usd(amount), final_capture: true }, headers);
const voidAuth = (authId) => pp('POST', `/v2/payments/authorizations/${authId}/void`);

const results = {};
function report(name, pass, detail) {
  results[name] = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${name}] ${pass ? 'PASS' : 'FAIL'} ${detail}`);
}

// S1: one buyer, 10 holds; capture 6 below the hold at different amounts, void 4.
async function s1() {
  const holds = [];
  for (let i = 0; i < 10; i++) holds.push(await hold(229));
  console.log('holds:', holds.map((h) => h.status).join(' '));
  const caps = [];
  for (let i = 0; i < 6; i++) caps.push(await capture(holds[i].authId, 219 - i));
  const voids = [];
  for (let i = 6; i < 10; i++) voids.push(await voidAuth(holds[i].authId));
  caps.forEach((c, i) => console.log(`capture ${219 - i}: ${c.status} ${c.json.status ?? c.json.name}`));
  voids.forEach((v) => console.log(`void: ${v.status} ${v.json.status ?? v.json.name}`));
  const ok = holds.every((h) => h.status === 'CREATED') &&
    caps.every((c) => c.json.status === 'COMPLETED' || c.json.status === 'PENDING') &&
    voids.every((v) => v.status === 200 || v.status === 204);
  report('S1', ok, '10 holds on one card, 6 partial final captures, 4 voids');
}

// S2: vault on first hold, then merchant-initiated hold with vault_id and no buyer present.
async function s2() {
  const first = await hold(229, {
    card: { ...TEST_CARD, attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } },
  });
  const vaultId = first.vault?.id;
  if (!vaultId) return report('S2', false, `no vault id returned (vault status: ${JSON.stringify(first.vault)})`);
  const mit = await hold(199, {
    card: { vault_id: vaultId, stored_credential: { payment_initiator: 'MERCHANT', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' } },
  }).catch((e) => ({ error: e.message }));
  await voidAuth(first.authId);
  if (mit.authId) await voidAuth(mit.authId);
  report('S2', !!mit.authId, mit.authId ? `merchant-initiated hold ${mit.status} from vault` : mit.error);
}

// S3 (local half): 50 holds, parallel capture/void fan-out, one injected decline, idempotent retry.
// The Render Workflows half is run separately once the Render service exists.
async function s3() {
  const holds = await Promise.all(Array.from({ length: 50 }, () => hold(229)));
  const declineIdx = 3;
  const outcomes = await Promise.all(holds.map((h, i) => {
    if (i >= 40) return voidAuth(h.authId).then((r) => ({ kind: 'void', ok: r.status < 300 }));
    const mock = i === declineIdx ? { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' }) } : {};
    return capture(h.authId, 219, mock).then((r) => ({
      kind: 'capture', i, ok: r.json.status === 'COMPLETED' || r.json.status === 'PENDING',
      issue: r.json.details?.[0]?.issue, authId: h.authId,
    }));
  }));
  const declined = outcomes.filter((o) => o.kind === 'capture' && !o.ok);
  console.log('declined:', declined.map((d) => `#${d.i} ${d.issue}`).join(', ') || 'none');
  // Idempotency: same PayPal-Request-Id twice must return the same capture, not a second one.
  const h = await hold(50);
  const reqId = randomUUID();
  const a = await capture(h.authId, 40, { 'PayPal-Request-Id': reqId });
  const b = await capture(h.authId, 40, { 'PayPal-Request-Id': reqId });
  const idem = a.json.id && a.json.id === b.json.id;
  const ok = declined.length === 1 && declined[0].i === declineIdx &&
    outcomes.filter((o) => o.ok).length === 49 && idem;
  report('S3-local', ok, `49/50 settled, injected decline caught, idempotent replay ${idem ? 'same capture id' : 'MISMATCH'}`);
}

// S4: Payouts to a sandbox brand account.
async function s4() {
  const r = await pp('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: randomUUID(), email_subject: 'Holdfast payout (spike)' },
    items: [{ recipient_type: 'EMAIL', amount: { value: '5000.00', currency: 'USD' },
      receiver: env.PAYPAL_BRAND_EMAIL || 'brand-spike@example.com', note: 'Cleared overstock window' }],
  });
  report('S4', r.status === 201, `payouts ${r.status} ${r.json.batch_header?.batch_status ?? r.json.name ?? ''}`);
}

const which = process.argv[2] || 'all';
await auth();
const spikes = { s1, s2, s3, s4 };
for (const [name, fn] of Object.entries(spikes)) {
  if (which !== 'all' && which !== name) continue;
  try { await fn(); } catch (e) { report(name.toUpperCase(), false, e.message); }
}
console.log('\nSummary:', results);
