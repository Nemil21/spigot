// Spigot PayPal spikes S7–S11 (SP-003): the CAPTURE / vault / refund / payout calls Holdfast never ran.
// Usage: node scripts/spikes-spigot.mjs <command>
//   s7a     card CAPTURE order, captured in the create call (+ create replay, capture on a completed order)
//   s7b     wallet CAPTURE order → print approval URL → poll ≤ 15 min → capture `capture:<id>` + replays
//   s8a     card CAPTURE + store_in_vault ON_SUCCESS → MIT CAPTURE from vault_id (+ replay, 2nd MIT)
//   s8b     wallet vault (usage_type MERCHANT) CAPTURE order → approve → capture → MIT paypal.vault_id CAPTURE
//   s8c     MIT CAPTURE with PayPal-Mock-Response INSTRUMENT_DECLINED
//   s9      partial refund with PayPal-Request-Id, replay, refund above the remaining amount
//   s10     one Payouts batch, 3 items (publisher, 2nd valid, unregistered), poll, resubmit sender_batch_id
//   s11     verify-webhook-signature call shape (dry run; `s11 <delivery.json>` with a real delivery in SP-059)
//   all     s7b + s8b approval links first, then s7a s8a s8c s9 s10 s11, then poll the wallet orders, check, render
//   resume  capture wallet orders (s7b/s8b) approved after their run ended; records PENDING-HUMAN otherwise
//   check   GET every order this spike created: each must be COMPLETED or never approved
//   render  write the evidence tables into spikes/spigot-results.md
// Same shape as spikes/paypal-spikes.mjs: reads ../.env, plain fetch, no deps, sandbox only.
// Raw evidence goes to spikes/spigot-evidence/ (git-ignored). Never prints the client secret, card numbers,
// payout emails or full vault ids. The wallet approval URL is printed: it only carries the order token.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = {
  ...Object.fromEntries(
    readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  ),
};
const BASE = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
if (!BASE.includes('sandbox')) throw new Error('spikes-spigot runs against the sandbox only');
const EVID = new URL('../spikes/spigot-evidence/', import.meta.url);
const RESULTS = new URL('../spikes/spigot-results.md', import.meta.url);
mkdirSync(EVID, { recursive: true });
if (!existsSync(new URL('.gitignore', EVID))) writeFileSync(new URL('.gitignore', EVID), '*\n');

// Publisher payout account: a separate US sandbox business account (paying the merchant itself gives
// SELF_PAY_NOT_ALLOWED, Holdfast S7). PAYPAL_BRAND_EMAIL is Holdfast's proven one.
const PUBLISHER_EMAIL = env.DEMO_PUBLISHER_PAYOUT_EMAIL || env.PAYPAL_BRAND_EMAIL;
const SECOND_EMAIL = env.SPIKE_SECOND_PAYOUT_EMAIL; // optional; falls back to a 2nd item to the publisher
const APPROVAL_WAIT_MS = Number(env.SPIKE_APPROVAL_WAIT_MS || 15 * 60_000);
const RETURN_URL = 'https://example.com/spigot-spike/return'; // nothing listens; we poll GET order instead
const CANCEL_URL = 'https://example.com/spigot-spike/cancel';

// PayPal's published sandbox test card; not a real card.
const TEST_CARD = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Spigot Spike',
};
const MIT = { payment_initiator: 'MERCHANT', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' };
const DECLINE = {
  'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' }),
};

// ---------- PayPal transport ----------
let token,
  tokenExp = 0;
async function auth() {
  if (token && Date.now() < tokenExp) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status}`);
  const j = await res.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in - 300) * 1000;
  return token;
}

// Every call returns a compact record; evidence never keeps the raw body (it can echo card or payer data).
async function pp(method, path, { body, requestId, headers = {}, label } = {}) {
  await auth();
  const rid = method === 'GET' ? undefined : (requestId ?? randomUUID());
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(rid ? { 'PayPal-Request-Id': rid } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    return {
      label,
      method,
      path,
      requestId: rid,
      http: 0,
      error: e.message,
      ms: Date.now() - t0,
      json: {},
    };
  }
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return {
    label,
    method,
    path: path.split('?')[0],
    requestId: rid,
    http: res.status,
    ms: Date.now() - t0,
    bodyStatus:
      json.status ??
      json.batch_header?.batch_status ??
      json.transaction_status ??
      json.verification_status,
    name: json.name,
    issue: json.details?.[0]?.issue,
    description: json.details?.[0]?.description ?? json.message,
    debugId: json.debug_id ?? res.headers.get('paypal-debug-id'),
    emptyBody: !text,
    json,
  };
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop the raw body from evidence
const strip = ({ json, ...rec }) => rec;

const usd = (v) => ({ currency_code: 'USD', value: Number(v).toFixed(2) });
const capOf = (j) => j?.purchase_units?.[0]?.payments?.captures?.[0];
const vaultOf = (j) =>
  j?.payment_source?.card?.attributes?.vault ?? j?.payment_source?.paypal?.attributes?.vault;
const short = (s) => (s ? `${String(s).slice(0, 4)}…` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- evidence ----------
const evFile = (step) => new URL(`${step}.json`, EVID);
const loadEv = (step) =>
  existsSync(evFile(step)) ? JSON.parse(readFileSync(evFile(step), 'utf8')) : [];
function saveAttempt(step, attempt) {
  const all = loadEv(step);
  all.push({ ranAt: new Date().toISOString(), ...attempt });
  writeFileSync(evFile(step), JSON.stringify(all, null, 2));
  console.log(
    `\n[${step}] ${attempt.result}${attempt.summary ? ' ' + JSON.stringify(attempt.summary) : ''}`,
  );
  return attempt;
}
// Every order the spike creates, so `check` can prove none is left approved-but-uncaptured.
const ORDERS = new URL('orders.jsonl', EVID);
const trackOrder = (step, orderId, kind) =>
  orderId &&
  appendFileSync(
    ORDERS,
    JSON.stringify({ at: new Date().toISOString(), step, orderId, kind }) + '\n',
  );
const trackedOrders = () =>
  existsSync(ORDERS)
    ? readFileSync(ORDERS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
// Wallet orders waiting for a human (s7b/s8b); `resume` picks them up after the run.
const PENDING = new URL('pending.json', EVID);
const loadPending = () => (existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf8')) : {});
const savePending = (p) => writeFileSync(PENDING, JSON.stringify(p, null, 2));
// Card vault id from s8a, reused by s8c (evidence dir is git-ignored; render only shows 4 chars).
const VAULTS = new URL('vaults.json', EVID);
const loadVaults = () => (existsSync(VAULTS) ? JSON.parse(readFileSync(VAULTS, 'utf8')) : {});
const saveVault = (k, v) =>
  writeFileSync(VAULTS, JSON.stringify({ ...loadVaults(), [k]: v }, null, 2));

function recorder() {
  const calls = [];
  const log = (r, note) => {
    calls.push({ ...strip(r), note });
    return r;
  };
  return { calls, log };
}

// ---------- money primitives (request ids per features/08: create = topupId, capture = capture:<topupId>) ----------
function cardOrderBody(topupId, amount, card, { invoice = true } = {}) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: topupId,
        ...(invoice ? { invoice_id: topupId } : {}),
        amount: usd(amount),
        description: 'Spigot spike top-up',
      },
    ],
    payment_source: { card },
  };
}
async function cardCapture(
  step,
  {
    topupId = randomUUID(),
    amount = 20,
    card = { ...TEST_CARD },
    label = 'order create (card CAPTURE)',
    headers,
    requestId,
  } = {},
) {
  const r = await pp('POST', '/v2/checkout/orders', {
    label,
    requestId: requestId ?? topupId,
    headers,
    body: cardOrderBody(topupId, amount, card),
  });
  const c = capOf(r.json);
  r.orderId = r.json.id;
  r.captureId = c?.id;
  r.captureStatus = c?.status;
  r.vault = vaultOf(r.json);
  trackOrder(step, r.orderId, 'card');
  return { ...r, topupId };
}
function walletOrderBody(topupId, amount, vault) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: topupId,
        invoice_id: topupId,
        amount: usd(amount),
        description: 'Spigot spike wallet top-up',
      },
    ],
    payment_source: {
      paypal: {
        ...(vault
          ? {
              attributes: {
                vault: {
                  store_in_vault: 'ON_SUCCESS',
                  usage_type: 'MERCHANT',
                  customer_type: 'CONSUMER',
                },
              },
            }
          : {}),
        experience_context: {
          return_url: RETURN_URL,
          cancel_url: CANCEL_URL,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          brand_name: 'Spigot spike',
        },
      },
    },
  };
}
const captureOrder = (orderId, requestId, label = 'capture order') =>
  pp('POST', `/v2/checkout/orders/${orderId}/capture`, { label, requestId });
const getOrder = (orderId, label = 'GET order') =>
  pp('GET', `/v2/checkout/orders/${orderId}`, { label });
const capNote = (r) =>
  `capture ${r.captureId ? short(r.captureId) : '–'} ${r.captureStatus ?? ''}`.trim();

// ---------- S7a: card CAPTURE captured in the create call ----------
async function s7a() {
  const { calls, log } = recorder();
  const a = await cardCapture('s7a', { amount: 20 });
  log({ ...a, bodyStatus: a.json.status }, `${capNote(a)}; order ${a.json.status}`);
  // Create replay (raw card, same PayPal-Request-Id): Holdfast saw 422 TRANSACTION_REFUSED for AUTHORIZE.
  const b = await cardCapture('s7a', {
    topupId: a.topupId,
    amount: 20,
    label: 'order create replay same id',
  });
  log(
    { ...b, bodyStatus: b.json.status },
    `same order: ${b.orderId === a.orderId}; ${capNote(b)}; same capture: ${!!b.captureId && b.captureId === a.captureId}`,
  );
  // Same invoice_id under a new request id: does PayPal dedupe the top-up?
  const c = await cardCapture('s7a', {
    topupId: a.topupId,
    requestId: randomUUID(),
    amount: 20,
    label: 'order create same invoice_id, new request id',
  });
  log(
    { ...c, bodyStatus: c.json.status },
    c.captureId ? `NEW order captured (${capNote(c)})` : 'rejected',
  );
  // Capture endpoint on an order already captured at create (what a retried capture step would hit).
  const d = log(
    await captureOrder(a.orderId, `capture:${a.topupId}`, 'capture order on COMPLETED order'),
  );
  const g = await getOrder(a.orderId);
  log(
    g,
    `order ${g.bodyStatus}, captures: ${g.json.purchase_units?.[0]?.payments?.captures?.length ?? 0}`,
  );
  // No-source CAPTURE order (the W11 wallet/card-fields create): replay with same id.
  const nsId = randomUUID();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{ custom_id: nsId, invoice_id: nsId, amount: usd(20) }],
  };
  const n1 = log(
    await pp('POST', '/v2/checkout/orders', {
      label: 'order create no source',
      requestId: nsId,
      body,
    }),
  );
  trackOrder('s7a', n1.json.id, 'no-source');
  const n2 = await pp('POST', '/v2/checkout/orders', {
    label: 'order create no source replay same id',
    requestId: nsId,
    body,
  });
  log(n2, `same order: ${n2.json.id === n1.json.id}`);
  if (n2.json.id && n2.json.id !== n1.json.id) trackOrder('s7a', n2.json.id, 'no-source');
  const pass = a.http === 201 && a.json.status === 'COMPLETED' && a.captureStatus === 'COMPLETED';
  return saveAttempt('s7a', {
    result: pass ? 'PASS' : 'FAIL',
    calls,
    summary: {
      createHttp: a.http,
      orderStatus: a.json.status,
      captureStatus: a.captureStatus,
      captureId: a.captureId,
      rawCardReplay: b.issue ?? (b.orderId === a.orderId ? 'same order' : b.json.status),
      sameInvoiceNewId: c.issue ?? (c.captureId ? 'captured twice' : c.json.status),
      captureOnCompleted: d.issue ?? d.bodyStatus,
      noSourceReplaySame: n2.json.id === n1.json.id,
    },
  });
}

// ---------- S7b / S8b: wallet orders (human approval) ----------
async function createWallet(step, { vault }) {
  const { calls, log } = recorder();
  const topupId = randomUUID();
  const r = log(
    await pp('POST', '/v2/checkout/orders', {
      label: `order create (wallet${vault ? ' + vault' : ''})`,
      requestId: topupId,
      body: walletOrderBody(topupId, vault ? 15 : 10, vault),
    }),
  );
  trackOrder(step, r.json.id, 'wallet');
  const rr = await pp('POST', '/v2/checkout/orders', {
    label: 'order create replay same id',
    requestId: topupId,
    body: walletOrderBody(topupId, vault ? 15 : 10, vault),
  });
  log(rr, `same order: ${rr.json.id === r.json.id}`);
  if (rr.json.id && rr.json.id !== r.json.id) trackOrder(step, rr.json.id, 'wallet');
  const link = r.json.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!link) {
    saveAttempt(step, {
      result: 'FAIL',
      calls,
      summary: { error: `no approval link (${r.http} ${r.issue ?? r.name ?? r.bodyStatus})` },
    });
    return null;
  }
  const p = loadPending();
  p[step] = { orderId: r.json.id, topupId, link, createdAt: Date.now(), calls };
  savePending(p);
  console.log(
    `\n[${step}] APPROVE IN A BROWSER with the sandbox Personal account (polling up to ${Math.round(APPROVAL_WAIT_MS / 60000)} min):\n  ${link}\n`,
  );
  return p[step];
}

// Poll until APPROVED (or the deadline), then finish the step. Returns true when the step is done.
async function finishWallet(step, { deadline }) {
  const p = loadPending()[step];
  if (!p) return true;
  const approved = (st) => st === 'APPROVED' || st === 'COMPLETED';
  let g = await getOrder(p.orderId);
  while (!approved(g.bodyStatus) && Date.now() < deadline) {
    await sleep(10_000);
    g = await getOrder(p.orderId);
  }
  const calls = [
    ...p.calls,
    {
      ...strip(g),
      note: `order state after waiting ${Math.round((Date.now() - p.createdAt) / 1000)} s`,
    },
  ];
  if (!approved(g.bodyStatus)) {
    saveAttempt(step, {
      result: 'PENDING-HUMAN',
      calls,
      summary: {
        orderStatus: g.bodyStatus,
        note: 'not approved in time; order left un-approved (expires on its own). Run `resume` after approving.',
      },
    });
    return false;
  }
  const log = (r, note) => {
    calls.push({ ...strip(r), note });
    return r;
  };
  const c1 = await captureOrder(p.orderId, `capture:${p.topupId}`, 'capture');
  const cap1 = capOf(c1.json);
  log(
    c1,
    `capture ${short(cap1?.id)} ${cap1?.status ?? ''}; vault ${vaultOf(c1.json)?.status ?? 'none'}`,
  );
  const c2 = await captureOrder(p.orderId, `capture:${p.topupId}`, 'capture replay same id');
  log(c2, `same capture id: ${!!cap1?.id && capOf(c2.json)?.id === cap1?.id}`);
  const c3 = log(await captureOrder(p.orderId, `capture:${p.topupId}-2`, 'capture again new id'));
  const summary = {
    captureHttp: c1.http,
    captureStatus: cap1?.status,
    captureId: cap1?.id,
    replayHttp: c2.http,
    replaySame: capOf(c2.json)?.id === cap1?.id,
    newIdIssue: c3.issue ?? c3.bodyStatus,
  };
  let pass = cap1?.status === 'COMPLETED';
  if (step === 's8b') {
    const v = vaultOf(c1.json);
    summary.vaultStatus = v?.status ?? 'none';
    summary.vaultId = short(v?.id);
    if (v?.id) {
      const mitId = randomUUID();
      const mitBody = {
        intent: 'CAPTURE',
        purchase_units: [{ custom_id: mitId, invoice_id: mitId, amount: usd(12) }],
        payment_source: { paypal: { vault_id: v.id } },
      };
      const m1 = await pp('POST', '/v2/checkout/orders', {
        label: 'wallet MIT CAPTURE (paypal.vault_id)',
        requestId: mitId,
        body: mitBody,
      });
      trackOrder(step, m1.json.id, 'wallet-mit');
      log(
        { ...m1, bodyStatus: m1.json.status },
        `capture ${short(capOf(m1.json)?.id)} ${capOf(m1.json)?.status ?? ''}`,
      );
      const m2 = await pp('POST', '/v2/checkout/orders', {
        label: 'wallet MIT replay same id',
        requestId: mitId,
        body: mitBody,
      });
      log(
        { ...m2, bodyStatus: m2.json.status },
        `same order: ${m2.json.id === m1.json.id}, same capture: ${!!capOf(m1.json)?.id && capOf(m2.json)?.id === capOf(m1.json)?.id}`,
      );
      if (m2.json.id && m2.json.id !== m1.json.id) trackOrder(step, m2.json.id, 'wallet-mit');
      summary.walletMit = capOf(m1.json)?.status ?? m1.issue ?? m1.json.status;
      summary.walletMitReplaySame = m2.json.id === m1.json.id;
      pass = pass && capOf(m1.json)?.status === 'COMPLETED';
    } else pass = false;
  }
  const pend = loadPending();
  delete pend[step];
  savePending(pend);
  saveAttempt(step, { result: pass ? 'PASS' : 'FAIL', calls, summary });
  return true;
}

async function s7b() {
  if (await createWallet('s7b', { vault: false }))
    await finishWallet('s7b', { deadline: Date.now() + APPROVAL_WAIT_MS });
}
async function s8b() {
  if (await createWallet('s8b', { vault: true }))
    await finishWallet('s8b', { deadline: Date.now() + APPROVAL_WAIT_MS });
}
async function resume() {
  const p = loadPending();
  if (!Object.keys(p).length) return console.log('no pending wallet orders');
  for (const step of Object.keys(p)) await finishWallet(step, { deadline: Date.now() });
}

// ---------- S8a: card vault on a CAPTURE order, then MIT CAPTURE ----------
async function s8a() {
  const { calls, log } = recorder();
  const v = await cardCapture('s8a', {
    amount: 20,
    card: { ...TEST_CARD, attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } },
    label: 'order create card CAPTURE + vault',
  });
  log(
    { ...v, bodyStatus: v.json.status },
    `${capNote(v)}; vault ${v.vault?.status ?? 'none'} ${short(v.vault?.id) ?? ''}`,
  );
  const vaultId = v.vault?.id;
  if (!vaultId)
    return saveAttempt('s8a', {
      result: 'FAIL',
      calls,
      summary: { error: 'no vault id', vault: v.vault?.status },
    });
  saveVault('card', vaultId);
  const mitCard = { vault_id: vaultId, stored_credential: MIT };
  const m1 = await cardCapture('s8a', {
    amount: 20,
    card: mitCard,
    label: 'MIT CAPTURE #1 (vault_id + stored_credential)',
  });
  log({ ...m1, bodyStatus: m1.json.status }, capNote(m1));
  const m1r = await cardCapture('s8a', {
    topupId: m1.topupId,
    amount: 20,
    card: mitCard,
    label: 'MIT CAPTURE #1 replay same id',
  });
  log(
    { ...m1r, bodyStatus: m1r.json.status },
    `same order: ${m1r.orderId === m1.orderId}, same capture: ${!!m1.captureId && m1r.captureId === m1.captureId}`,
  );
  const m2 = await cardCapture('s8a', {
    amount: 25,
    card: mitCard,
    label: 'MIT CAPTURE #2 new id',
  });
  log({ ...m2, bodyStatus: m2.json.status }, capNote(m2));
  const pass =
    v.captureStatus === 'COMPLETED' &&
    v.vault?.status === 'VAULTED' &&
    m1.captureStatus === 'COMPLETED' &&
    m2.captureStatus === 'COMPLETED';
  return saveAttempt('s8a', {
    result: pass ? 'PASS' : 'FAIL',
    calls,
    summary: {
      firstCapture: v.captureStatus,
      vaultStatus: v.vault?.status,
      vaultId: short(vaultId),
      mit1: m1.captureStatus ?? m1.issue,
      mit1ReplayHttp: m1r.http,
      mit1ReplaySame: m1r.orderId === m1.orderId && m1r.captureId === m1.captureId,
      mit2: m2.captureStatus ?? m2.issue,
    },
  });
}

// ---------- S8c: MIT CAPTURE, mocked INSTRUMENT_DECLINED ----------
async function s8c() {
  const { calls, log } = recorder();
  let vaultId = loadVaults().card;
  if (!vaultId) {
    const v = await cardCapture('s8c', {
      amount: 20,
      card: { ...TEST_CARD, attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } },
      label: 'order create card CAPTURE + vault',
    });
    log({ ...v, bodyStatus: v.json.status }, `${capNote(v)}; vault ${v.vault?.status ?? 'none'}`);
    vaultId = v.vault?.id;
    if (vaultId) saveVault('card', vaultId);
  }
  if (!vaultId)
    return saveAttempt('s8c', { result: 'FAIL', calls, summary: { error: 'no vault id' } });
  const d = await cardCapture('s8c', {
    amount: 20,
    card: { vault_id: vaultId, stored_credential: MIT },
    headers: DECLINE,
    label: 'MIT CAPTURE + mock INSTRUMENT_DECLINED',
  });
  log(
    { ...d, bodyStatus: d.json.status ?? d.bodyStatus },
    `order id: ${d.orderId ?? 'none'}; capture ${d.captureStatus ?? '–'}; body keys: ${Object.keys(d.json).join(',') || '(empty)'}`,
  );
  let realState;
  if (d.orderId) {
    const g = log(await getOrder(d.orderId), 'real state after mocked decline');
    realState = g.bodyStatus;
  }
  const shape = {
    http: d.http,
    name: d.name,
    issue: d.issue,
    description: d.description,
    emptyBody: d.emptyBody,
    orderId: d.orderId ?? null,
    captureStatus: d.captureStatus ?? null,
    realState,
  };
  // PASS = the decline itself: 422 INSTRUMENT_DECLINED, or a capture that is not COMPLETED.
  // Any other error (400 INVALID_REQUEST, 401, 5xx) is a FAIL, not the decline path.
  const pass =
    (d.http === 422 && d.issue === 'INSTRUMENT_DECLINED') ||
    (!!d.captureStatus && d.captureStatus !== 'COMPLETED');
  return saveAttempt('s8c', { result: pass ? 'PASS' : 'FAIL', calls, summary: shape });
}

// ---------- S9: partial refund + replays ----------
async function s9() {
  const { calls, log } = recorder();
  const t = await cardCapture('s9', { amount: 20, label: 'order create card CAPTURE $20' });
  log({ ...t, bodyStatus: t.json.status }, capNote(t));
  if (!t.captureId)
    return saveAttempt('s9', { result: 'FAIL', calls, summary: { error: 'no capture' } });
  const refund = (amount, requestId, label) =>
    pp('POST', `/v2/payments/captures/${t.captureId}/refund`, {
      label,
      requestId,
      body: { amount: usd(amount), note_to_payer: 'Spigot unused balance refund (spike)' },
    });
  const rid = randomUUID();
  const r1 = log(await refund(7.4, rid, 'refund $7.40'), 'partial refund');
  const r2 = await refund(7.4, rid, 'refund $7.40 replay same id');
  log(r2, `same refund id: ${!!r1.json.id && r2.json.id === r1.json.id}`);
  const r3 = await refund(3, rid, 'refund replay same id, different amount ($3.00)');
  log(
    r3,
    `same refund id: ${!!r1.json.id && r3.json.id === r1.json.id}; amount ${r3.json.amount?.value ?? '–'}`,
  );
  const r4 = log(await refund(5, randomUUID(), 'refund $5.00 new id'), 'second partial refund');
  const r5 = log(
    await refund(10, randomUUID(), 'refund $10.00 new id (above remaining $7.60)'),
    'above remaining',
  );
  const g = await pp('GET', `/v2/payments/captures/${t.captureId}`, { label: 'GET capture' });
  log(g, `capture ${g.bodyStatus}`);
  const pass =
    r1.bodyStatus === 'COMPLETED' &&
    r2.json.id === r1.json.id &&
    r4.bodyStatus === 'COMPLETED' &&
    r5.http === 422 &&
    r5.issue === 'REFUND_AMOUNT_EXCEEDED';
  return saveAttempt('s9', {
    result: pass ? 'PASS' : 'FAIL',
    calls,
    summary: {
      refund1: `${r1.http} ${r1.bodyStatus}`,
      replay: `${r2.http} ${r2.bodyStatus} same=${r2.json.id === r1.json.id}`,
      replayDifferentAmount: `${r3.http} ${r3.bodyStatus ?? r3.issue} same=${r3.json.id === r1.json.id} amount=${r3.json.amount?.value}`,
      refund2: `${r4.http} ${r4.bodyStatus}`,
      aboveRemaining: `${r5.http} ${r5.issue ?? r5.name}`,
      captureAfter: g.bodyStatus,
    },
  });
}

// ---------- S10: one Payouts batch, 3 items, poll, duplicate sender_batch_id ----------
async function s10() {
  if (!PUBLISHER_EMAIL)
    throw new Error('set DEMO_PUBLISHER_PAYOUT_EMAIL (or PAYPAL_BRAND_EMAIL) in .env');
  const { calls, log } = recorder();
  const batchId = randomUUID();
  const items = [
    { role: 'publisher', receiver: PUBLISHER_EMAIL, value: 12.34 },
    {
      role: SECOND_EMAIL ? 'second valid' : 'publisher (2nd item)',
      receiver: SECOND_EMAIL || PUBLISHER_EMAIL,
      value: 5,
    },
    {
      role: 'unregistered',
      receiver: `spigot-s10-${randomUUID().slice(0, 8)}@example.com`,
      value: 3.21,
    },
  ].map((it, i) => ({ ...it, itemId: `${batchId.slice(0, 8)}-${i + 1}` }));
  const body = {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'Spigot payout (spike)',
      email_message: 'Spigot: records sold (spike)',
    },
    items: items.map((it) => ({
      recipient_type: 'EMAIL',
      amount: { value: it.value.toFixed(2), currency: 'USD' },
      receiver: it.receiver,
      sender_item_id: it.itemId,
      note: 'Spigot: records sold (spike)',
    })),
  };
  const roleOf = (sid) => items.find((it) => it.itemId === sid)?.role ?? sid;
  const p = log(
    await pp('POST', '/v1/payments/payouts', {
      label: 'POST payouts (3 items)',
      requestId: batchId,
      body,
    }),
    'sender_batch_id = PayPal-Request-Id = batch id',
  );
  const payoutBatchId = p.json.batch_header?.payout_batch_id;
  // Crash-resume case: resubmit at once with the same sender_batch_id and the same request id.
  const p2 = await pp('POST', '/v1/payments/payouts', {
    label: 'resubmit same sender_batch_id + same request id (immediately)',
    requestId: batchId,
    body,
  });
  log(
    p2,
    `payout_batch_id same: ${!!payoutBatchId && p2.json.batch_header?.payout_batch_id === payoutBatchId}`,
  );
  if (!payoutBatchId)
    return saveAttempt('s10', {
      result: 'FAIL',
      calls,
      summary: { error: `no batch (${p.http} ${p.name ?? ''})` },
    });
  const polls = [];
  const t0 = Date.now();
  let b;
  do {
    await sleep(10_000);
    b = await pp('GET', `/v1/payments/payouts/${payoutBatchId}`, { label: 'GET payout batch' });
    polls.push({
      t: Date.now() - t0,
      batch: b.bodyStatus,
      items: (b.json.items ?? []).map((i) => i.transaction_status),
    });
  } while (
    !['SUCCESS', 'DENIED', 'CANCELED'].includes(b.bodyStatus) &&
    Date.now() - t0 < 5 * 60_000
  );
  log(b, `batch ${b.bodyStatus} after ${Math.round((Date.now() - t0) / 1000)} s`);
  const itemStates = {};
  for (const it of b.json.items ?? []) {
    const role = roleOf(it.payout_item?.sender_item_id);
    const gi = await pp('GET', `/v1/payments/payouts-item/${it.payout_item_id}`, {
      label: `GET payout item (${role})`,
    });
    itemStates[role] = it.transaction_status + (it.errors?.name ? ` ${it.errors.name}` : '');
    log(
      { ...gi, bodyStatus: gi.json.transaction_status },
      `item ${gi.json.transaction_status}${gi.json.errors?.name ? ' ' + gi.json.errors.name : ''}; fee ${gi.json.payout_item_fee?.value ?? '–'}`,
    );
  }
  const p3 = log(
    await pp('POST', '/v1/payments/payouts', {
      label: 'resubmit same sender_batch_id, new request id (after terminal)',
      requestId: randomUUID(),
      body,
    }),
  );
  const pass =
    b.bodyStatus === 'SUCCESS' &&
    itemStates.publisher?.startsWith('SUCCESS') &&
    itemStates.unregistered?.startsWith('UNCLAIMED') &&
    p3.http === 400 &&
    p3.name === 'USER_BUSINESS_ERROR';
  return saveAttempt('s10', {
    result: pass ? 'PASS' : 'FAIL',
    calls,
    summary: {
      postHttp: p.http,
      postStatus: p.bodyStatus,
      payoutBatchId,
      immediateResubmit: `${p2.http} ${p2.name ?? p2.bodyStatus ?? ''} same=${p2.json.batch_header?.payout_batch_id === payoutBatchId}`,
      batchFinal: b.bodyStatus,
      items: itemStates,
      duplicateAfterTerminal: `${p3.http} ${p3.name ?? ''} ${p3.description ?? ''}`.trim(),
      polls,
    },
  });
}

// ---------- S11: verify-webhook-signature call shape ----------
// Dry run (no real delivery yet): synthetic headers + a sample PAYMENT.CAPTURE.COMPLETED event, to record the
// request shape and the error PayPal returns. SP-059 runs `s11 <delivery.json>` with {headers, rawBody} captured
// at the Render URL and PAYPAL_WEBHOOK_ID set. webhook_event must be the parsed raw body, unmodified.
async function s11(file) {
  const { calls, log } = recorder();
  const delivery = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : {
        headers: {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url':
            'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-dryrun',
          'paypal-transmission-id': randomUUID(),
          'paypal-transmission-sig': 'ZHJ5LXJ1bg==',
          'paypal-transmission-time': new Date().toISOString(),
        },
        rawBody: JSON.stringify({
          id: 'WH-DRYRUN',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource: { id: 'DRYRUN', status: 'COMPLETED' },
        }),
      };
  const h = Object.fromEntries(
    Object.entries(delivery.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const body = {
    auth_algo: h['paypal-auth-algo'],
    cert_url: h['paypal-cert-url'],
    transmission_id: h['paypal-transmission-id'],
    transmission_sig: h['paypal-transmission-sig'],
    transmission_time: h['paypal-transmission-time'],
    webhook_id: env.PAYPAL_WEBHOOK_ID || '0SPIKEDRYRUN00000',
    webhook_event: JSON.parse(delivery.rawBody),
  };
  const r = await pp('POST', '/v1/notifications/verify-webhook-signature', {
    label: `verify-webhook-signature (${file ? 'real delivery' : 'dry run'})`,
    body,
  });
  log(r, `verification_status ${r.json.verification_status ?? '–'}`);
  const result = file
    ? r.json.verification_status === 'SUCCESS'
      ? 'PASS'
      : 'FAIL'
    : 'SCRIPT-ONLY';
  return saveAttempt('s11', {
    result,
    calls,
    summary: {
      http: r.http,
      verificationStatus: r.json.verification_status,
      name: r.name,
      issue: r.issue,
      requestKeys: Object.keys(body),
    },
  });
}

// ---------- check: nothing left approved-but-uncaptured ----------
async function check() {
  const seen = new Map();
  for (const o of trackedOrders()) seen.set(o.orderId, o);
  const states = {};
  const bad = [];
  for (const o of seen.values()) {
    const g = await getOrder(o.orderId);
    const st = g.http === 404 ? 'NOT_FOUND' : g.bodyStatus;
    states[st] = (states[st] ?? 0) + 1;
    // COMPLETED = captured; CREATED / PAYER_ACTION_REQUIRED = never approved (expires on its own). APPROVED = needs capture.
    if (!['COMPLETED', 'CREATED', 'PAYER_ACTION_REQUIRED', 'NOT_FOUND'].includes(st))
      bad.push({ step: o.step, orderId: o.orderId, status: st });
  }
  return saveAttempt('check', {
    result: bad.length ? 'FAIL' : 'PASS',
    summary: { orders: seen.size, states, needsAction: bad },
  });
}

// ---------- render ----------
const STEPS = [
  ['s7a', 'S7a: card CAPTURE, captured in the create call'],
  ['s7b', 'S7b: wallet CAPTURE → approve → capture `capture:<id>` + replays'],
  ['s8a', 'S8a: card vault on CAPTURE, then MIT CAPTURE from vault_id'],
  ['s8b', 'S8b: wallet vault (usage_type MERCHANT) on CAPTURE, then wallet MIT CAPTURE'],
  ['s8c', 'S8c: MIT CAPTURE with mock INSTRUMENT_DECLINED'],
  ['s9', 'S9: partial refund + replays + refund above remaining'],
  ['s10', 'S10: Payouts batch with 3 items, poll, duplicate sender_batch_id'],
  ['s11', 'S11: verify-webhook-signature call shape'],
  ['check', 'Final check: every order created is captured or un-approved'],
];
const cell = (v) =>
  v === undefined || v === null || v === ''
    ? '–'
    : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function render() {
  const out = [
    '<!-- spigot-evidence:start -->',
    '_Generated by `node scripts/spikes-spigot.mjs render` from spikes/spigot-evidence/ (git-ignored)._',
    '',
  ];
  for (const [step, title] of STEPS) {
    const all = loadEv(step);
    if (!all.length) {
      out.push(`### ${title}`, '', '_Not run._', '');
      continue;
    }
    const last = all.at(-1);
    out.push(`### ${title}`, '', `Last run ${last.ranAt}: **${last.result}**`);
    if (all.length > 1)
      out.push(`Attempts: ${all.map((a) => `${a.ranAt} ${a.result}`).join(' · ')}`);
    out.push('');
    if (last.calls?.length) {
      out.push(
        '| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |',
        '|---|---|---|---|---|---|---|---|',
      );
      for (const c of last.calls) {
        out.push(
          `| ${cell(c.label)} | ${c.requestId ? '`' + c.requestId + '`' : '–'} | ${cell(c.http)} | ${cell(c.bodyStatus)} | ${cell(c.issue ?? c.name ?? (c.emptyBody && c.http >= 400 ? '(empty body)' : undefined))} | ${cell(c.debugId)} | ${cell(c.ms)} | ${cell(c.note)} |`,
        );
      }
      out.push('');
    }
    if (last.summary) {
      const { vaultId, ...rest } = last.summary; // already shortened, but keep the summary free of full ids
      out.push(
        '```json',
        JSON.stringify(vaultId ? { ...rest, vaultId: short(vaultId) } : rest, null, 2),
        '```',
        '',
      );
    }
  }
  out.push('<!-- spigot-evidence:end -->');
  const block = out.join('\n');
  const cur = existsSync(RESULTS)
    ? readFileSync(RESULTS, 'utf8')
    : '# Spigot PayPal spike results (SP-003)\n\n';
  const re = /<!-- spigot-evidence:start -->[\s\S]*<!-- spigot-evidence:end -->/;
  writeFileSync(RESULTS, re.test(cur) ? cur.replace(re, block) : `${cur.trimEnd()}\n\n${block}\n`);
  console.log(`rendered ${STEPS.length} steps into spikes/spigot-results.md`);
}

// ---------- all: wallet approvals run in parallel with the other steps ----------
async function all() {
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  const wallets = [];
  for (const [step, vault] of [
    ['s7b', false],
    ['s8b', true],
  ]) {
    if (await safe(step, () => createWallet(step, { vault }))) wallets.push(step);
  }
  for (const [step, fn] of [
    ['s7a', s7a],
    ['s8a', s8a],
    ['s8c', s8c],
    ['s9', s9],
    ['s10', s10],
    ['s11', () => s11()],
  ])
    await safe(step, fn);
  for (const step of wallets) await safe(step, () => finishWallet(step, { deadline }));
  await safe('check', check);
  render();
}

async function safe(step, fn) {
  try {
    return await fn();
  } catch (e) {
    saveAttempt(step, { result: 'FAIL', summary: { error: e.message } });
    return null;
  }
}

const [cmd = 'all', arg] = process.argv.slice(2);
const commands = {
  s7a,
  s7b,
  s8a,
  s8b,
  s8c,
  s9,
  s10,
  s11: () => s11(arg),
  all,
  resume,
  check,
  render,
};
if (!commands[cmd]) {
  console.error(`unknown command ${cmd}; one of: ${Object.keys(commands).join(' ')}`);
  process.exit(2);
}
if (cmd !== 'render') await auth();
await safe(cmd, commands[cmd]);
