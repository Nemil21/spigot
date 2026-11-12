// `npm run demo:dry-run` (SP-039b): run the video script end to end against a running local stack
// and print a report for docs/demo/dry-run-checklist.md. Helpers in `./demo-dry-run.lib.ts`.
//
//   npm run demo:dry-run                                   # one run; Claude Code CLI is the buyer agent
//   npm run demo:dry-run -- --runs 2                       # run, demo:reset, run again (the SP-039b gate)
//   npm run demo:dry-run -- --topup wallet                 # wait for a person to top up $20 in W11
//   npm run demo:dry-run -- --agent sdk                    # scripted MCP calls instead of `claude -p`
//   npm run demo:dry-run -- --out /tmp/dry-run.md          # also write the report to a file
//
// Needs: the API (`npm run dev`) and the demo site running, `seed:demo` done, and
//   DRY_RUN_PUBLISHER_PASSWORD / DRY_RUN_BUYER_PASSWORD   (printed by seed:demo; env, not flags)
//   SPIGOT_API_BASE (default http://localhost:3000), DEMO_SITE_URL (default http://localhost:4100)
//   DATABASE_URL etc. (the repo .env) for `--topup sim`, `demo:mutate`, `sim:buyers`, `demo:reset`.
// The publisher must be in ADMIN_EMAILS for `POST /admin/ledger/check`.
//
// Steps (checklist rows): 2.1 crawl → 2.2 proposals → 3.2 publish Listing (agent_phone hidden,
// $1.50 / 1,000) → 3.3 three 402s for python-requests → 4.1 demo:mutate --focus → 4.2 DEMO_MUTATE
// crawl → 4.3 sim:buyers → 5.2 Acme top-up → 6.1/6.2 buyer agent over /mcp → 7.1 W08 call.charged
// event → 8.1/8.2 payout run → Sent → Paid out → 9.2 ledger check; with --runs 2, 9.5 demo:reset
// and 9.6 ledger check between the runs.
//
// The buyer API key is minted for each run through Acme's portal session (`POST /api/buyer/keys`)
// and revoked at the end; it only ever reaches the agent through a 0600 temp file passed with
// `--mcp-config` and deleted afterwards. Nothing here prints a key, password or PayPal secret.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ALLOWED_TOOLS,
  HIDDEN_FIELDS,
  judgeAgentRun,
  mcpConfig,
  parseClaudeStream,
  parseSimWeekGross,
  PROMPT_CARD,
  redact,
  reportMarkdown,
  usd,
  type StepResult,
} from './demo-dry-run.lib.js';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    topup: { type: 'string', default: 'sim' }, // sim | wallet | skip
    agent: { type: 'string', default: 'claude' }, // claude | sdk
    'publisher-email': { type: 'string', default: 'owner@bluebonnet-rentals.example.com' },
    'buyer-email': { type: 'string', default: 'acme@acme-agents.example.com' },
    'skip-sim-buyers': { type: 'boolean', default: false },
    'payout-wait-min': { type: 'string', default: '5' },
    'topup-wait-min': { type: 'string', default: '10' },
    model: { type: 'string' },
    out: { type: 'string' },
  },
});

const API = (process.env.SPIGOT_API_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
const SITE = (process.env.DEMO_SITE_URL ?? 'http://localhost:4100').replace(/\/+$/, '');
const REPO = new URL('..', import.meta.url).pathname;
const runs = Number(values.runs);
const pubPassword = process.env.DRY_RUN_PUBLISHER_PASSWORD;
const buyerPassword = process.env.DRY_RUN_BUYER_PASSWORD;
if (!pubPassword || !buyerPassword) {
  console.error(
    'Set DRY_RUN_PUBLISHER_PASSWORD and DRY_RUN_BUYER_PASSWORD (seed:demo prints both).',
  );
  process.exit(2);
}
if (!['sim', 'wallet', 'skip'].includes(values.topup!)) throw new Error('--topup sim|wallet|skip');
if (!['claude', 'sdk'].includes(values.agent!)) throw new Error('--agent claude|sdk');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${redact(s)}`);

// The slices of API responses this script reads (api.md); error bodies are only ever printed.
interface CrawlRun {
  id: string;
  trigger: string;
  status: string;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsRemoved: number;
  error: string | null;
  finishedAt: string | null;
}
interface Site {
  id: string;
  slug: string;
  origin?: string;
}
interface Proposal {
  datasetId: string;
  slug: string;
  typeName: string;
  records: number;
  sourceBadge: string;
}
interface DatasetDetail {
  status: string;
  fields: { name: string; pii: boolean }[];
  latestSchemaVersion?: { id: string; version: number };
}
interface Topup {
  status: string;
  createdAt: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
}
interface PayoutItem {
  id: string;
  paypalItemId: string | null;
  status: string;
  netCents: number;
  receiverEmail: string;
}
interface PayoutBatch {
  id: string;
  paypalBatchId: string | null;
  status: string;
  trigger: string;
  items: PayoutItem[];
}
interface ApiBody {
  sites?: Site[];
  runs?: CrawlRun[];
  proposals?: Proposal[];
  datasets?: { id: string; slug: string }[];
  siteStatus?: string;
  running?: boolean;
  status?: string;
  endpoint?: string;
  crawlRunId?: string;
  balanceMicros?: number;
  topups?: Topup[];
  id?: string;
  key?: string;
  kpis?: { grossMicros: number; commissionMicros: number; netMicros: number };
  outcome?: string;
  batchId?: string | null;
  batches?: PayoutBatch[];
  sumMicros?: number;
  accountsChecked?: number;
  mismatches?: unknown[];
}
interface DatasetBody extends Omit<ApiBody, 'status'>, DatasetDetail {}
type Res<T = ApiBody> = { status: number; json: T };

/** A cookie session against the API (publisher or buyer portal). Sends the CSRF `Origin`. */
function session() {
  let cookie = '';
  const call = async <T = ApiBody>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> => {
    const r = await fetch(API + path, {
      method,
      headers: {
        origin: API,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    let json: unknown = { text };
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json: json as T };
  };
  return Object.assign(call, { cookie: () => cookie });
}

async function until<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs: number,
  everyMs = 1000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(everyMs);
  }
}

/** Run an npm script in the repo; stdout/stderr captured (and redacted before anything prints). */
function npm(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  return run('npm', ['run', '-s', ...args], env);
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = REPO,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
    p.on('error', (err) => resolve({ code: 127, out: String(err) }));
  });
}

const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];

/** seed:demo's 20 SIM buyers (SP-035). */
const SIM_BUYER_EMAILS = Array.from(
  { length: 20 },
  (_, i) => `sim-buyer-${String(i + 1).padStart(2, '0')}@sim.spigot.example.com`,
);

/** Server-side SIM card top-ups (`./demo-dry-run.topup.ts`); one result line per buyer. */
async function simTopups(cents: number, emails: string[], weekStart = false): Promise<string[]> {
  const r = await run('npx', [
    'tsx',
    '--conditions=source',
    'scripts/demo-dry-run.topup.ts',
    ...(weekStart ? ['--week-start'] : []),
    String(cents),
    ...emails,
  ]);
  if (r.code !== 0) throw new Error(`SIM top-up exit ${r.code}: ${r.out.slice(-300)}`);
  return r.out.trim().split('\n').slice(-emails.length);
}

async function runOnce(n: number): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const step = async (row: string, name: string, fn: () => Promise<string>, required = true) => {
    const t0 = Date.now();
    log(`[run ${n}] ${row} ${name} …`);
    try {
      const detail = await fn();
      steps.push({ row, name, ok: true, detail, ms: Date.now() - t0 });
      log(`[run ${n}] ${row} OK  ${detail}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ row, name, ok: false, detail, ms: Date.now() - t0 });
      log(`[run ${n}] ${row} FAIL ${detail}`);
      if (required) throw new StopRun();
    }
  };

  const pub = session();
  const buyer = session();
  let siteId = '';
  let datasetId = '';
  let siteSlug = '';
  let keyId = '';
  let apiKey = '';
  let payoutBatchId = '';

  try {
    await step('0.4', 'API + demo site up, publisher and buyer sign in', async () => {
      const h = await fetch(`${API}/api/healthz`);
      if (!h.ok) throw new Error(`GET /api/healthz ${h.status}`);
      const s = await fetch(`${SITE}/`);
      if (!s.ok) throw new Error(`demo site ${s.status}`);
      const a = await pub('POST', '/api/auth/login', {
        email: values['publisher-email'],
        password: pubPassword,
      });
      if (a.status !== 200) throw new Error(`publisher login ${a.status}`);
      const b = await buyer('POST', '/api/buyer/login', {
        email: values['buyer-email'],
        password: buyerPassword,
      });
      if (b.status !== 200) throw new Error(`buyer login ${b.status}`);
      const sites = await pub('GET', '/api/sites');
      const list = sites.json.sites ?? [];
      const site =
        list.find((x) => typeof x.origin === 'string' && x.origin.replace(/\/+$/, '') === SITE) ??
        list[0];
      if (!site) throw new Error('no site: run seed:demo');
      siteId = site.id;
      siteSlug = site.slug;
      return `site ${siteSlug} ${siteId}`;
    });

    await step('2.1', 'Crawl (or wait for demo:reset’s crawl)', async () => {
      const latest = async () => {
        const r = await pub('GET', `/api/sites/${siteId}/crawl-runs`);
        return (r.json.runs ?? []).filter((x) => x.trigger !== 'APPROVE');
      };
      const before = await latest();
      let runId: string;
      const fresh = (r: CrawlRun) =>
        r.status === 'SUCCEEDED' && Date.now() - Date.parse(r.finishedAt ?? '') < 5 * 60_000;
      if (before[0] && (!TERMINAL.includes(before[0].status) || fresh(before[0]))) {
        runId = before[0].id; // demo:reset's crawl (running, or just finished): checklist 9.7
      } else {
        const c = await pub('POST', `/api/sites/${siteId}/crawl`, {});
        if (c.status !== 202)
          throw new Error(`POST crawl ${c.status} ${JSON.stringify(c.json).slice(0, 200)}`);
        runId = c.json.crawlRunId ?? '';
      }
      const done = await until(
        async () => (await latest()).find((x) => x.id === runId && TERMINAL.includes(x.status)),
        15 * 60_000,
        2000,
      );
      if (done.status !== 'SUCCEEDED')
        throw new Error(`crawl ${runId} ${done.status}: ${done.error ?? ''}`);
      return `run ${runId} (${done.trigger}) ${done.pagesFetched}/${done.pagesTotal} fetched, ${done.pagesNotModified} not modified`;
    });

    await step('2.2', 'Proposals ready (3 record types)', async () => {
      await until(
        async () => {
          const s = await pub('GET', `/api/sites/${siteId}/proposal-status`);
          return s.json.siteStatus === 'READY' && !s.json.running ? true : null;
        },
        10 * 60_000,
        2000,
      );
      const p = await pub('GET', `/api/sites/${siteId}/proposals`);
      const props = p.json.proposals ?? [];
      // A LIVE dataset is no longer a proposal (a run started without demo:reset).
      const ds = await pub('GET', `/api/sites/${siteId}/datasets`);
      const all = ds.json.datasets ?? [];
      datasetId =
        props.find((x) => x.slug === 'listings')?.datasetId ??
        all.find((x) => x.slug === 'listings')?.id ??
        '';
      if (!datasetId)
        throw new Error(`no listings dataset (proposals: ${props.map((x) => x.slug).join(', ')})`);
      return props.map((x) => `${x.typeName} · ${x.records} (${x.sourceBadge})`).join(', ');
    });

    await step('3.2', 'Publish Listing: agent_phone hidden, $1.50 / 1,000', async () => {
      const d = await pub<DatasetBody>('GET', `/api/datasets/${datasetId}`);
      const pii = d.json.fields.filter((f) => f.pii).map((f) => f.name);
      if (!pii.includes('agent_phone'))
        throw new Error(`agent_phone not flagged PII (pii: ${pii.join(', ')})`);
      if (d.json.status === 'LIVE') return `already LIVE (dataset ${datasetId})`;
      const patch = await pub('PATCH', `/api/datasets/${datasetId}`, {
        fields: HIDDEN_FIELDS.map((name) => ({ name, visible: false })),
        perRecordMicros: 1500,
      });
      if (patch.status !== 200)
        throw new Error(`PATCH ${patch.status} ${JSON.stringify(patch.json).slice(0, 200)}`);
      const svid = d.json.latestSchemaVersion?.id;
      const t0 = Date.now();
      const a = await pub('POST', `/api/datasets/${datasetId}/approve`, {
        schemaVersionId: svid,
        rightsAttested: true,
      });
      if (a.status !== 200)
        throw new Error(`approve ${a.status} ${JSON.stringify(a.json).slice(0, 200)}`);
      const runId = a.json.crawlRunId ?? '';
      const r = await until(async () => {
        const x = await pub('GET', `/api/sites/${siteId}/crawl-runs`);
        return (x.json.runs ?? []).find((y) => y.id === runId && TERMINAL.includes(y.status));
      }, 10 * 60_000);
      if (r.status !== 'SUCCEEDED') throw new Error(`APPROVE run ${r.status}`);
      return `dataset ${datasetId} · schema v${d.json.latestSchemaVersion?.version} ${svid} · records +${r.recordsAdded} ~${r.recordsUpdated} · publish → live ${((Date.now() - t0) / 1000).toFixed(0)} s · ${a.json.endpoint}`;
    });

    await step('3.3', 'Scraper gets 402s (python-requests UA)', async () => {
      // Same as scripts/scraper-demo.py, without needing Python: the gate classifies by UA.
      // The gate refreshes its policy every few seconds after a publish; give it up to 60 s.
      const paths = [
        '/listings/3br-tarrytown-grackle-pass-1',
        '/listings/2br-old-town-buda-sage-meadow-pass-2',
        '/listings/3br-holly-indigo-bush-cv-3',
      ];
      const codes = await until(
        async () => {
          const got = await Promise.all(
            paths.map(async (p) => {
              const r = await fetch(SITE + p, {
                headers: { 'user-agent': 'python-requests/2.32.3', accept: 'application/json' },
              });
              const body = await r.text();
              return { status: r.status, priced: body.includes('1.50') };
            }),
          );
          return got.every((g) => g.status === 402) ? got : null;
        },
        60_000,
        2000,
      );
      if (!codes.every((c) => c.priced)) throw new Error('402 body has no "$1.50 per 1,000"');
      return `3 × 402 with "$1.50 per 1,000"`;
    });

    await step('4.1', 'demo:mutate --focus "bedrooms>=3,price_usd<2000,city=Austin"', async () => {
      const seed = String(40 + n);
      const r = await npm([
        'demo:mutate',
        '--',
        '--prices',
        '30',
        '--leased',
        '5',
        '--new',
        '3',
        '--seed',
        seed,
        '--focus',
        'bedrooms>=3,price_usd<2000,city=Austin',
        '--target',
        SITE,
      ]);
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(-300)}`);
      const lastmod = r.out.match(/pages with a new lastmod: (\d+)/)?.[1];
      return `seed ${seed} · ${lastmod ?? '?'} pages with a new lastmod`;
    });

    await step('4.2', 'DEMO_MUTATE crawl: only touched pages re-fetched', async () => {
      const c = await pub('POST', `/api/sites/${siteId}/crawl`, { trigger: 'DEMO_MUTATE' });
      if (c.status !== 202)
        throw new Error(`POST crawl ${c.status} ${JSON.stringify(c.json).slice(0, 200)}`);
      const runId = c.json.crawlRunId;
      const r = await until(
        async () => {
          const x = await pub('GET', `/api/sites/${siteId}/crawl-runs`);
          return (x.json.runs ?? []).find((y) => y.id === runId && TERMINAL.includes(y.status));
        },
        10 * 60_000,
        1000,
      );
      if (r.status !== 'SUCCEEDED') throw new Error(`run ${r.status}`);
      return `run ${runId} · ${r.pagesFetched}/${r.pagesTotal} pages · records +${r.recordsAdded} ~${r.recordsUpdated} -${r.recordsRemoved} · AI calls 0`;
    });

    if (!values['skip-sim-buyers']) {
      await step(
        '4.3',
        'sim:buyers (simulated week)',
        async () => {
          // A re-take after demo:reset finds the simulated week already at its target (and paid
          // out by the last run's payout), so "Run payout now" would have nothing to pay. If the
          // default pass adds nothing, raise the week's target by $500 to give the payout beat money.
          const week = async (args: string[]) => {
            const r = await npm(['sim:buyers', ...(args.length ? ['--', ...args] : [])]);
            if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(-300)}`);
            const line = r.out.split('\n').find((l) => l.startsWith('Week ')) ?? '';
            return { line: line.trim(), gross: parseSimWeekGross(line) };
          };
          let w = await week([]);
          if (w.gross && w.gross.after - w.gross.before < 1) {
            // The SIM buyers are out of balance (demo:reset doesn't re-fund them): $30 each.
            await simTopups(3000, SIM_BUYER_EMAILS, true);
            w = await week(['--target-usd', String(Math.ceil(w.gross.after + 300))]);
            return `${w.line} (after re-funding ${SIM_BUYER_EMAILS.length} SIM buyers $30 each)`;
          }
          return w.line;
        },
        false,
      );
    }

    await step('5.2', `Acme top-up $20 (${values.topup})`, async () => {
      const bal0 = (await buyer('GET', '/api/buyer/balance')).json;
      const b0 = Number(bal0.balanceMicros ?? 0);
      if (values.topup === 'skip') return `skipped · balance ${usd(b0)}`;
      if (values.topup === 'sim') {
        // Stub / rehearsal only: a server-side SIM card top-up stands in for the wallet approval.
        const ids = (await simTopups(2000, [values['buyer-email']!]))[0]!.replace(/^\S+ /, '');
        const b1 = Number((await buyer('GET', '/api/buyer/balance')).json.balanceMicros);
        return `SIM card top-up ${ids} · balance ${usd(b0)} → ${usd(b1)}`;
      }
      log(
        `  Open ${API}/buyers as ${values['buyer-email']}, pick $20, Top up with PayPal, approve as the sandbox Personal account.`,
      );
      const t0 = Date.now();
      const done = await until(
        async () => {
          const t = await buyer('GET', '/api/buyer/topups');
          const list = t.json.topups ?? [];
          return list.find(
            (x) => x.status === 'COMPLETED' && Date.parse(x.createdAt) >= t0 - 60_000,
          );
        },
        Number(values['topup-wait-min']) * 60_000,
        1000,
      );
      const b1 = Number((await buyer('GET', '/api/buyer/balance')).json.balanceMicros);
      return `order ${done.paypalOrderId} · capture ${done.paypalCaptureId} · balance ${usd(b0)} → ${usd(b1)}`;
    });

    await step('6.1', 'Mint a buyer key for the agent', async () => {
      const k = await buyer('POST', '/api/buyer/keys', {
        name: `dry-run ${n} ${new Date().toISOString().slice(0, 16)}`,
        scopes: ['read'],
      });
      if (k.status !== 201) throw new Error(`POST /api/buyer/keys ${k.status}`);
      keyId = k.json.id ?? '';
      apiKey = k.json.key ?? '';
      if (!apiKey) throw new Error('key create returned no secret');
      return `key ${keyId} (read)`;
    });

    // W08's live row: the publisher event stream sees `call.charged` when the agent pays.
    const events = watchEvents(pub);
    let agentDoneAt = 0;
    await step('6.2', `Buyer agent (${values.agent}) runs the prompt card over /mcp`, async () => {
      const bal0 = Number((await buyer('GET', '/api/buyer/balance')).json.balanceMicros);
      const detail =
        values.agent === 'claude' ? await claudeAgent(apiKey) : await sdkAgent(apiKey, siteSlug);
      agentDoneAt = Date.now();
      const bal1 = Number((await buyer('GET', '/api/buyer/balance')).json.balanceMicros);
      if (!(bal1 < bal0))
        throw new Error(`${detail} · no charge (balance ${usd(bal0)} → ${usd(bal1)})`);
      return `${detail} · charged ${usd(bal0 - bal1)} · balance after ${usd(bal1)}`;
    });

    await step(
      '7.1',
      'W08 sees the charge (call.charged event)',
      async () => {
        const at = await events.firstChargedAt;
        events.stop();
        if (!at) throw new Error('no call.charged event within the window');
        const e = await pub('GET', '/api/publishers/me/earnings');
        const k = e.json.kpis ?? { grossMicros: 0, commissionMicros: 0, netMicros: 0 };
        return `event ${at <= agentDoneAt ? 'during' : `${((at - agentDoneAt) / 1000).toFixed(1)} s after`} the agent run · gross ${usd(k.grossMicros)} · commission ${usd(k.commissionMicros)} · net ${usd(k.netMicros)}`;
      },
      false,
    );

    await step('8.1', 'Run payout now (demo control)', async () => {
      const r = await pub('POST', '/api/publishers/me/payouts/run', {});
      if (r.status !== 200)
        throw new Error(`POST payouts/run ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      payoutBatchId = r.json.batchId ?? '';
      if (!payoutBatchId)
        throw new Error(
          `no batch: ${r.json.outcome} (nothing payable: run sim:buyers with a higher --target-usd)`,
        );
      const p = await pub('GET', '/api/publishers/me/payouts');
      const b = (p.json.batches ?? []).find((x) => x.id === payoutBatchId);
      if (!b) throw new Error(`batch ${payoutBatchId} not in GET /api/publishers/me/payouts`);
      const items = b.items;
      const net = items.reduce((sum, i) => sum + Number(i.netCents ?? 0), 0);
      return `batch ${b.paypalBatchId ?? b.id} (${b.trigger}) · ${b.status} · net ${usd(net * 10_000)} · items ${items.map((i) => `${i.paypalItemId ?? i.id} ${i.status} → ${i.receiverEmail}`).join(', ')}`;
    });

    await step(
      '8.2',
      'Payout item Sent → Paid out',
      async () => {
        const t0 = Date.now();
        const b = await until(
          async () => {
            const p = await pub('GET', '/api/publishers/me/payouts');
            const batch = (p.json.batches ?? []).find((x) => x.id === payoutBatchId);
            const items = batch?.items ?? [];
            return items.length &&
              items.every(
                (i) => !['PENDING', 'SENT', 'PROCESSING', 'UNCLAIMED', 'ONHOLD'].includes(i.status),
              )
              ? batch
              : null;
          },
          Number(values['payout-wait-min']) * 60_000,
          3000,
        );
        return `${b.status} · ${b.items.map((i) => i.status).join(', ')} after ${((Date.now() - t0) / 1000).toFixed(0)} s`;
      },
      false,
    );
  } catch (err) {
    if (!(err instanceof StopRun)) throw err;
  } finally {
    if (keyId) await buyer('DELETE', `/api/buyer/keys/${keyId}`).catch(() => undefined);
  }

  await step('9.2', 'POST /admin/ledger/check = 0', () => ledgerCheck(pub), false);
  return steps;
}

class StopRun extends Error {}

async function ledgerCheck(pub: ReturnType<typeof session>): Promise<string> {
  const r = await pub('POST', '/admin/ledger/check', {});
  if (r.status !== 200)
    throw new Error(`POST /admin/ledger/check ${r.status} (is the publisher in ADMIN_EMAILS?)`);
  const j = r.json;
  const mismatches = j.mismatches ?? [];
  if (Number(j.sumMicros) !== 0 || mismatches.length)
    throw new Error(`sumMicros ${j.sumMicros}, ${mismatches.length} mismatch(es)`);
  return `sumMicros 0, mismatches 0, ${j.accountsChecked ?? '?'} accounts`;
}

/** Subscribe to the publisher SSE stream; resolve with the time of the first `call.charged`. */
function watchEvents(pub: ReturnType<typeof session>) {
  const controller = new AbortController();
  let resolveAt!: (t: number | null) => void;
  const firstChargedAt = new Promise<number | null>((r) => (resolveAt = r));
  const timer = setTimeout(() => resolveAt(null), 10 * 60_000);
  void (async () => {
    const r = await fetch(`${API}/api/publishers/me/events`, {
      headers: { accept: 'text/event-stream', cookie: pub.cookie() },
      signal: controller.signal,
    }).catch(() => null);
    if (!r?.body) return resolveAt(null);
    const dec = new TextDecoder();
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        if (dec.decode(chunk).includes('call.charged')) return resolveAt(Date.now());
      }
    } catch {
      /* aborted */
    }
    resolveAt(null);
  })();
  return {
    firstChargedAt,
    stop: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

/** Claude Code CLI as the buyer agent: `claude -p <prompt card>` with Spigot's MCP server. */
async function claudeAgent(apiKey: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'spigot-dry-run-'));
  const cfg = join(dir, 'mcp.json');
  try {
    writeFileSync(cfg, JSON.stringify(mcpConfig(API, apiKey)), { mode: 0o600 });
    const args = [
      '-p',
      PROMPT_CARD,
      '--mcp-config',
      cfg,
      '--strict-mcp-config',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--output-format',
      'stream-json',
      '--verbose',
      ...(values.model ? ['--model', values.model] : []),
    ];
    // Run from the empty temp dir so no project CLAUDE.md, settings or hooks shape the take.
    const r = await run('claude', args, {}, dir);
    if (r.code === 127)
      throw new Error('claude not found: install Claude Code CLI or use --agent sdk');
    const t = parseClaudeStream(r.out);
    const v = judgeAgentRun(t);
    const summary = `claude -p: tools ${t.tools.join(' → ') || '(none)'} · turns ${t.numTurns ?? '?'}`;
    if (!v.ok) throw new Error(`${summary} · RE-TAKE: ${v.problems.join('; ')}`);
    return `${summary} · reply: "${t.finalText.replace(/\s+/g, ' ').slice(0, 160)}…"`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same four calls without an LLM (CI-like rehearsal, or no Claude Code on the machine). */
async function sdkAgent(apiKey: string, siteSlug: string): Promise<string> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'spigot-dry-run', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  );
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const filters = [
      { field: 'bedrooms', op: 'gte', value: 3 },
      { field: 'price_usd', op: 'lt', value: 2000 },
      { field: 'city', op: 'eq', value: 'Austin' },
    ];
    const target = { site: siteSlug, dataset: 'listings' };
    await client.callTool({ name: 'list_datasets', arguments: {} });
    await client.callTool({ name: 'describe_dataset', arguments: target });
    const q = await client.callTool({ name: 'quote', arguments: { ...target, filters } });
    const s = await client.callTool({
      name: 'search_records',
      arguments: { ...target, filters, idempotencyKey: randomUUID() },
    });
    const text = JSON.stringify(s);
    for (const f of HIDDEN_FIELDS)
      if (text.includes(f)) throw new Error(`hidden field ${f} leaked`);
    const sc = (s.structuredContent ?? {}) as { records?: unknown[]; callId?: string };
    return `sdk: ${tools.length} tools listed (${tools.join(', ')}) · quote ${JSON.stringify(q.structuredContent ?? {}).slice(0, 120)} · ${sc.records?.length ?? '?'} records, call ${sc.callId ?? '?'}`;
  } finally {
    await client.close();
  }
}

// ---- main ------------------------------------------------------------------------------------

const t0 = Date.now();
const reports: string[] = [];
let failed = 0;
for (let n = 1; n <= runs; n++) {
  const rt0 = Date.now();
  const steps = await runOnce(n);
  if (n < runs) {
    const t = Date.now();
    log(`[run ${n}] 9.5 demo:reset --yes …`);
    const r = await npm(['demo:reset', '--', '--yes']);
    const resetLine = r.out
      .split('\n')
      .filter((l) => /reset|rotated|crawl/i.test(l))
      .slice(-3)
      .join(' / ');
    steps.push({
      row: '9.5',
      name: 'demo:reset --yes',
      ok: r.code === 0,
      detail: redact(r.code === 0 ? resetLine : r.out.slice(-300)),
      ms: Date.now() - t,
    });
    const pub = session();
    await pub('POST', '/api/auth/login', {
      email: values['publisher-email'],
      password: pubPassword,
    });
    const lt = Date.now();
    try {
      steps.push({
        row: '9.6',
        name: 'Ledger check after reset = 0',
        ok: true,
        detail: await ledgerCheck(pub),
        ms: Date.now() - lt,
      });
    } catch (err) {
      steps.push({
        row: '9.6',
        name: 'Ledger check after reset = 0',
        ok: false,
        detail: String(err),
        ms: Date.now() - lt,
      });
    }
  }
  failed += steps.filter((s) => !s.ok).length;
  reports.push(
    reportMarkdown(
      `Run ${n} (${new Date(rt0).toISOString()}, agent ${values.agent}, top-up ${values.topup})`,
      steps,
      Date.now() - rt0,
    ),
  );
}
const report = `${reports.join('\n\n')}\n\nAll runs: ${((Date.now() - t0) / 60_000).toFixed(1)} min, ${failed} failed step(s).\n`;
console.log(`\n${report}`);
if (values.out) writeFileSync(values.out, report);
process.exit(failed ? 1 : 0);
