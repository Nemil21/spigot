#!/usr/bin/env node
// SP-040 smoke for a Spigot stack, local or on Render (docs/deploy.md §Smoke). No dependencies.
//
//   node scripts/smoke-deploy.mjs http://localhost:3000 --site http://localhost:4100
//   node scripts/smoke-deploy.mjs https://spigot-api.onrender.com \
//     --site https://bluebonnet-rentals.onrender.com --strict
//
// Steps: API /api/healthz → web app at / → GET /v1/catalog → GET /api/gate/policy (401 without a
// key; with SPIGOT_GATE_KEY in the environment, the site's policy) → demo site /healthz → a
// listing page from its sitemap: a human browser and Googlebot get 200, GPTBot gets the 402
// contract (docs/spec/api.md §The 402 contract).
//
// A step whose feature isn't merged yet (the API answers "No route for …", or the demo site's
// gate passes GPTBot because it isn't installed or has no policy yet) is reported as `pending`
// with the ticket that delivers it, and doesn't fail the run. `--strict` (use it on Render after
// the freeze) turns every pending or skipped step into a failure. `--site` defaults to
// DEMO_SITE_URL. Tokens come from the environment and are never printed.
// Exit 0 only if every step that ran passed.
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string' },
    strict: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '15' },
  },
});
const trim = (u) => u?.replace(/\/+$/, '');
const base = trim(positionals[0]);
const site = trim(values.site ?? process.env.DEMO_SITE_URL);
if (!base) {
  console.error(
    'usage: node scripts/smoke-deploy.mjs <api-base> [--site <demo-site-url>] [--strict] [--timeout 15]',
  );
  process.exit(2);
}
const strict = values.strict;
const timeoutMs = Number(values.timeout) * 1000;
const gateKey = process.env.SPIGOT_GATE_KEY?.trim() || '';

let failures = 0;
let pendings = 0;
const ok = (msg) => console.log(`  ok       ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL     ${msg}`);
};
/** Not built yet (or not configured yet): fine locally before the freeze, a failure with --strict. */
const pending = (msg) => {
  if (strict) return fail(`${msg} (--strict)`);
  pendings++;
  console.log(`  pending  ${msg}`);
};
const step = (name) => console.log(`\n${name}`);
const check = (pass, okMsg, failMsg) => (pass ? ok(okMsg) : fail(failMsg));

const UA = {
  human:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  gptbot:
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
};

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  } catch (err) {
    return { status: 0, json: null, text: '', headers: new Headers(), error: err.message };
  }
}

const describe = (r) => (r.status ? `${r.status} ${r.json?.error?.code ?? ''}`.trim() : r.error);
/** The API's JSON 404 for an unregistered route (apps/api/src/http/errors.ts). */
const noRoute = (r) =>
  r.status === 404 &&
  r.json?.error?.code === 'NOT_FOUND' &&
  /^No route for /.test(r.json.error.message ?? '');

step(`1. API health (${base})`);
const h = await get(`${base}/api/healthz`);
check(h.status === 200 && h.json?.ok === true, '/api/healthz ok', `/api/healthz → ${describe(h)}`);

step('2. Web app (same origin)');
const spa = await get(`${base}/`, { accept: 'text/html' });
if (spa.status === 200 && /<html/i.test(spa.text)) ok('/ serves the web app');
else if (spa.status === 503) pending('/ → 503: web app not built (npm run build -w @spigot/web)');
else fail(`/ → ${describe(spa)}`);

step('3. Catalog (GET /v1/catalog, free)');
const cat = await get(`${base}/v1/catalog`);
if (cat.status === 200 && Array.isArray(cat.json?.sites)) {
  const datasets = cat.json.sites.flatMap((s) => s.datasets ?? []);
  ok(`${cat.json.sites.length} site(s), ${datasets.length} published dataset(s)`);
} else if (noRoute(cat)) pending('/v1/catalog not built yet (SP-017a / SP-017b)');
else fail(`/v1/catalog → ${describe(cat)}`);

step('4. Gate policy (GET /api/gate/policy)');
const anon = await get(`${base}/api/gate/policy`);
if (noRoute(anon)) {
  pending('/api/gate/policy not built yet (SP-008b)');
} else {
  check(anon.status === 401, 'no gate key → 401', `no gate key → ${describe(anon)} (expected 401)`);
  if (!gateKey) {
    pending("set SPIGOT_GATE_KEY (the site's gk_… key from W03) to fetch the policy");
  } else {
    const pol = await get(`${base}/api/gate/policy`, { authorization: `Bearer ${gateKey}` });
    check(
      pol.status === 200 &&
        Number.isInteger(pol.json?.policyVersion) &&
        Array.isArray(pol.json?.gatedPaths),
      `policy v${pol.json?.policyVersion}, ${pol.json?.gatedPaths?.length} gated path(s)`,
      `policy with gate key → ${describe(pol)}`,
    );
  }
}

step(`5. Demo site gate (${site ?? 'no --site'})`);
if (!site) {
  pending('pass --site <demo-site-url> (or set DEMO_SITE_URL) to check the gate 402');
} else {
  const dh = await get(`${site}/healthz`);
  check(dh.status === 200, 'demo site /healthz', `demo site /healthz → ${describe(dh)}`);

  // A real listing page from the sitemap, rebased onto --site (the sitemap uses the public origin).
  const sm = await get(`${site}/sitemap.xml`, {
    accept: 'application/xml',
    'user-agent': UA.human,
  });
  const loc = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .find((u) => /\/listings\/[^/]+$/.test(u));
  if (!loc) {
    fail(`no /listings/ URL in ${site}/sitemap.xml (→ ${describe(sm)})`);
  } else {
    const path = new URL(loc).pathname;
    ok(`sitemap → ${path}`);
    const human = await get(`${site}${path}`, { accept: 'text/html', 'user-agent': UA.human });
    check(human.status === 200, 'human browser → 200', `human browser → ${describe(human)}`);
    const goog = await get(`${site}${path}`, { accept: 'text/html', 'user-agent': UA.googlebot });
    check(goog.status === 200, 'Googlebot → 200 (search passes)', `Googlebot → ${describe(goog)}`);

    const bot = await get(`${site}${path}`, { 'user-agent': UA.gptbot });
    if (bot.status === 402) {
      check(
        bot.json?.error?.code === 'PAYMENT_REQUIRED',
        'GPTBot → 402 PAYMENT_REQUIRED',
        `GPTBot 402 body error.code ${bot.json?.error?.code ?? '(not JSON)'}`,
      );
      const links = bot.headers.get('link') ?? '';
      check(
        /rel="?payment"?/.test(links),
        'Link rel="payment" (catalog)',
        `Link header: ${links || '(none)'}`,
      );
      const cacheControl = bot.headers.get('cache-control') ?? '';
      check(
        cacheControl.includes('no-store'),
        'Cache-Control no-store',
        `Cache-Control ${cacheControl || '(none)'}`,
      );
      check(
        Array.isArray(bot.json?.datasets) && bot.json?.pay?.provider === 'PayPal',
        `${bot.json?.datasets?.length} dataset(s) quoted, pay with PayPal`,
        '402 body lacks datasets / pay.provider',
      );
    } else if (bot.status === 200) {
      pending(
        'GPTBot → 200: gate not installed (SP-006b) or no policy yet (connect the site, set ' +
          'SPIGOT_GATE_KEY + SPIGOT_API_BASE on the demo site, publish a dataset); it fails open',
      );
    } else {
      fail(`GPTBot → ${describe(bot)} (expected 402)`);
    }
  }
}

const tail = pendings ? ` (${pendings} pending; run with --strict after the freeze)` : '';
console.log(failures ? `\nSMOKE FAILED: ${failures} step(s)${tail}` : `\nSMOKE PASSED${tail}`);
process.exit(failures ? 1 : 0);
