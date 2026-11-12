// `npm run seed:demo` (SP-035; features/15 §Seed script, §Labelling rules; features/12 §Pieces 2).
//
// Produces the demo's cast and nothing else: the discovery crawl and the AI proposal run live.
//  1. Publisher "Bluebonnet Rentals (demo)", `is_demo = true`, payouts to DEMO_PUBLISHER_PAYOUT_EMAIL
//     (the separate US sandbox business account; paying the merchant itself is SELF_PAY_NOT_ALLOWED).
//  2. The demo site, connected and VERIFIED with the preset token (SPIGOT_VERIFY_TOKEN). No crawl:
//     the presenter starts it (`POST /api/sites/:id/crawl`). Gate and crawl keys are printed.
//  3. "Acme Agents (demo)": the real foreground buyer, no balance (it tops up on camera).
//  4. 20 SIM buyers (`is_simulated`), each with a key and one $20–$50 sandbox card top-up through
//     `serverCardTopup` (SP-018b) with the deterministic id `uuidv5(email + ':seed')`, at most 3 at
//     once. The TOPUP ledger txn is dated to the start of the simulated week. A top-up PayPal
//     rate-limited (429) is completed ledger-only on the same row, `paypal_order_id = null`
//     ("SIM (no PayPal)").
//
// Idempotent and safe to run twice at once: rows are found by email / origin (`ON CONFLICT DO
// NOTHING`), top-ups by their deterministic id (only the run whose insert wins calls PayPal; the
// other reconciles), keys and passwords are derived from SESSION_SECRET so a re-run prints the same
// ones without storing them.
import { createHmac } from 'node:crypto';
import PQueue from 'p-queue';
import { v5 as uuidv5 } from 'uuid';
import { centsToMicros } from '@spigot/shared';
import { audit } from '../audit/audit.js';
import { base62, hashKey, API_KEY_PREFIX } from '../auth/apiKeys.js';
import { hashPassword } from '../auth/password.js';
import type { Config } from '../config.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import { transition, type Db, type Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import type { PayPalOrdersClient } from '../paypal/index.js';
import { createRecordedModel } from '../schema-agent/claude.js';
import { proposeForSite, type ProposeResult } from '../schema-agent/propose.js';
import { sha256Hex, VERIFY_PATH } from '../sites/keys.js';
import { baseSlug, normalizeOrigin, pickSlug } from '../sites/sites.js';
import {
  serverCardTopup,
  topupById,
  TOPUP_COLUMNS,
  type ServerCardTopupOutcome,
  type TopupRow,
} from '../topups/index.js';

// ---------------------------------------------------------------------------------------------
// The cast (SP-036 / SP-038 import these instead of repeating them)

/** Namespace for the seed's uuidv5 ids. Fixed forever: changing it orphans every seeded top-up. */
export const SEED_NAMESPACE = '6c1f6f0e-3b0a-5d5e-9a51-5b1d2f0c7a35';

export const DEMO_PUBLISHER = {
  name: 'Bluebonnet Rentals (demo)',
  email: 'owner@bluebonnet-rentals.example.com',
} as const;

export const DEMO_BUYER = {
  name: 'Acme Agents (demo)',
  email: 'acme@acme-agents.example.com',
} as const;

/** The demo site when DEMO_SITE_URL is unset (apps/demo-site's default port). */
export const DEFAULT_DEMO_SITE_URL = 'http://localhost:4100';

export const SIM_BUYER_COUNT = 20;
/** features/15 §Seed 6: SIM top-ups run at most this many at once. */
export const SIM_TOPUP_CONCURRENCY = 3;
/** SIM keys call more often than a person (SP-036's backfill); the column default is 60. */
export const SIM_KEY_RATE_LIMIT_PER_MIN = 600;

const SIM_NAMES = [
  'Atlas Crawl',
  'Bramble Bots',
  'Cobalt Research',
  'Delta Scout',
  'Ember Index',
  'Fjord Agents',
  'Granite Labs',
  'Harbor AI',
  'Iris Fetch',
  'Juniper Data',
  'Kestrel Search',
  'Lumen Agents',
  'Mesa Analytics',
  'Nimbus Reader',
  'Orchid Assist',
  'Pike Insights',
  'Quarry Bots',
  'Rowan Agents',
  'Sable Crawl',
  'Tundra Labs',
] as const;

export interface SimBuyerSpec {
  /** 1-based. */
  n: number;
  name: string;
  email: string;
  /** Whole dollars, $20–$50, fixed per buyer. */
  topupCents: number;
}

export function simBuyers(count: number = SIM_BUYER_COUNT): SimBuyerSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const nn = String(n).padStart(2, '0');
    const email = `sim-buyer-${nn}@sim.spigot.example.com`;
    return {
      n,
      name: `${SIM_NAMES[i % SIM_NAMES.length]} (SIM ${nn})`,
      email,
      topupCents: simTopupCents(email),
    };
  });
}

/** $20–$50 in whole dollars, stable per email (a re-run must ask for the same amount). */
export function simTopupCents(email: string): number {
  const h = sha256Hex(`spigot-seed-amount:${email}`);
  return (20 + (parseInt(h.slice(0, 8), 16) % 31)) * 100;
}

/** The SIM buyer's one seed top-up id: `uuidv5(buyerEmail + ':seed')`. Never a fresh one. */
export function seedTopupId(buyerEmail: string): string {
  return uuidv5(`${buyerEmail}:seed`, SEED_NAMESPACE);
}

export function seedSiteId(origin: string): string {
  return uuidv5(`site:${origin}`, SEED_NAMESPACE);
}

/**
 * The start of the simulated week (SP-036 backdates SIM calls inside it): UTC midnight seven days
 * before `now`.
 */
export function simulatedWeekStart(now: Date = new Date()): Date {
  const d = new Date(now.getTime() - 7 * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function hmac(secret: string, label: string): Buffer {
  if (!secret) throw new Error('seed: SESSION_SECRET is empty');
  return createHmac('sha256', secret).update(label).digest();
}

/**
 * A seeded buyer's API key, derived from SESSION_SECRET and the email (like the crawl key), so a
 * re-run (and SP-036's `sim:buyers`) gets the same key without it ever being stored in clear.
 */
export function seedApiKey(secret: string, email: string): string {
  return `${API_KEY_PREFIX}${base62(hmac(secret, `spigot-seed-api-key:v1:${email}`))}`;
}

/** The demo site's gate key, derived like the crawl key so every run prints the same one. */
export function seedGateKey(secret: string, siteId: string): string {
  return `gk_${hmac(secret, `spigot-seed-gate-key:v1:${siteId}`).toString('base64url')}`;
}

/** The verify token when SPIGOT_VERIFY_TOKEN is unset (print it for the demo site's env). */
export function seedVerifyToken(secret: string, origin: string): string {
  return `spigot-verify=${hmac(secret, `spigot-seed-verify:v1:${origin}`).toString('hex').slice(0, 32)}`;
}

/** Portal password for a seeded login (publisher, Acme): derived, printed, never stored in clear. */
export function seedPassword(secret: string, email: string): string {
  return `demo-${hmac(secret, `spigot-seed-password:v1:${email}`).toString('base64url').slice(0, 16)}`;
}

/** Stub mode only: where the demo publisher's payouts go when DEMO_PUBLISHER_PAYOUT_EMAIL is unset. */
export const STUB_PAYOUT_EMAIL = 'payouts@bluebonnet-rentals.example.com';

/** PayPal said "slow down" to the order create: nothing was created, so ledger-only is honest. */
const RATE_LIMIT_CODES = new Set(['RATE_LIMIT_REACHED', 'HTTP_429']);

/** The label W14 / the README use for a SIM top-up with no PayPal order. */
export const SIM_NO_PAYPAL_LABEL = 'SIM (no PayPal)';

// ---------------------------------------------------------------------------------------------
// Seed

export interface SeedDeps {
  db: Db;
  config: Config;
  pp: PayPalOrdersClient;
}

export interface SeedOptions {
  withProposals?: boolean;
  /** Default 20. */
  simBuyers?: number;
  /** Default 3. */
  concurrency?: number;
  now?: Date;
  /** Progress lines (no secrets). */
  log?: (line: string) => void;
}

export interface SeededLogin {
  id: string;
  name: string;
  email: string;
  /** Derived; the same on every run with the same SESSION_SECRET. */
  password: string;
  created: boolean;
}

export interface SeededSimTopup {
  buyerId: string;
  email: string;
  name: string;
  apiKey: string;
  topupId: string;
  amountCents: number;
  /**
   * `serverCardTopup`'s outcome, `LEDGER_ONLY` for the rate-limited fallback, or `ERROR` when
   * PayPal couldn't be reached to reconcile (safe to re-run).
   */
  status: ServerCardTopupOutcome['status'] | 'LEDGER_ONLY' | 'ERROR';
  /** True when this run inserted the top-up row (and so made the one PayPal call). */
  created: boolean;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  code?: string | null;
}

export interface SeedDemoResult {
  publisher: SeededLogin & { payoutEmail: string; isDemo: boolean };
  site: {
    id: string;
    origin: string;
    slug: string;
    status: string;
    created: boolean;
    verify: { path: string; content: string };
    gateKey: string;
    crawlKey: string;
    /** Whether the stored gate key hash matches the printed key (false: rotated since the seed). */
    gateKeyMatches: boolean;
  };
  acme: SeededLogin & { apiKey: string };
  simTopups: SeededSimTopup[];
  simulatedAt: Date;
  proposals:
    { status: 'skipped'; reason: string } | { status: 'ran'; result: ProposeResult } | null;
  elapsedMs: number;
}

export async function seedDemo(deps: SeedDeps, opts: SeedOptions = {}): Promise<SeedDemoResult> {
  const started = Date.now();
  const { db, config } = deps;
  const log = opts.log ?? (() => {});
  if (config.PAYPAL_MODE !== 'stub' && !config.paypalIsSandbox) {
    throw new Error(
      'seed:demo makes raw test-card top-ups: run it on PAYPAL_MODE=stub or the sandbox',
    );
  }
  const secret = config.SESSION_SECRET;
  const simulatedAt = simulatedWeekStart(opts.now);

  const payoutEmail =
    config.DEMO_PUBLISHER_PAYOUT_EMAIL ??
    (config.PAYPAL_MODE === 'stub' ? STUB_PAYOUT_EMAIL : undefined);
  if (!payoutEmail) {
    throw new Error(
      'seed:demo needs DEMO_PUBLISHER_PAYOUT_EMAIL: the separate US sandbox business account that receives the demo payout (not the merchant).',
    );
  }

  const publisher = await upsertPublisher(db, secret, payoutEmail);
  log(`publisher ${publisher.created ? 'created' : 'found'}: ${publisher.name} (${publisher.id})`);
  if (publisher.payoutEmail !== payoutEmail) {
    log(`  note: payout_email on file differs from DEMO_PUBLISHER_PAYOUT_EMAIL; left unchanged`);
  }

  const site = await upsertSite(db, config, publisher.id);
  log(`site ${site.created ? 'connected + verified' : 'found'}: ${site.origin} (${site.status})`);

  const acmeLogin = await upsertBuyer(db, {
    name: DEMO_BUYER.name,
    email: DEMO_BUYER.email,
    simulated: false,
    password: seedPassword(secret, DEMO_BUYER.email),
  });
  const acmeKey = seedApiKey(secret, DEMO_BUYER.email);
  await ensureKey(db, acmeLogin.id, acmeKey, {
    name: 'Claude Desktop (demo)',
    scopes: ['read', 'topup'],
  });
  log(`buyer ${acmeLogin.created ? 'created' : 'found'}: ${DEMO_BUYER.name} (no balance)`);

  const specs = simBuyers(opts.simBuyers ?? SIM_BUYER_COUNT);
  const queue = new PQueue({ concurrency: opts.concurrency ?? SIM_TOPUP_CONCURRENCY });
  const simTopups = await Promise.all(
    specs.map((spec) =>
      queue.add(async () => {
        const out = await seedSimBuyer(deps, spec, simulatedAt);
        log(
          `SIM ${String(spec.n).padStart(2, '0')} $${spec.topupCents / 100}: ${out.status}` +
            `${out.created ? '' : ' (existing)'}${out.code ? ` ${out.code}` : ''}`,
        );
        return out;
      }),
    ),
  );

  let proposals: SeedDemoResult['proposals'] = null;
  if (opts.withProposals) proposals = await replayProposals(db, site.id);

  return {
    publisher,
    site,
    acme: { ...acmeLogin, apiKey: acmeKey },
    simTopups,
    simulatedAt,
    proposals,
    elapsedMs: Date.now() - started,
  };
}

/** Every SIM buyer funded: captured at PayPal, or the labelled ledger-only fallback. */
export function allFunded(r: Pick<SeedDemoResult, 'simTopups'>): boolean {
  return r.simTopups.every((t) => t.status === 'COMPLETED' || t.status === 'LEDGER_ONLY');
}

// ---------------------------------------------------------------------------------------------
// Rows

async function upsertPublisher(
  db: Db,
  secret: string,
  payoutEmail: string,
): Promise<SeedDemoResult['publisher']> {
  const password = seedPassword(secret, DEMO_PUBLISHER.email);
  const existing = await findPublisher(db.pool);
  if (existing) return { ...existing, password, created: false };
  const passwordHash = await hashPassword(password);
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO publishers (name, email, password_hash, payout_email, is_demo)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [DEMO_PUBLISHER.name, DEMO_PUBLISHER.email, passwordHash, payoutEmail],
  );
  const row = (await findPublisher(db.pool))!;
  return { ...row, password, created: rows.length > 0 };
}

async function findPublisher(q: Queryable) {
  const { rows } = await q.query<{
    id: string;
    name: string;
    email: string;
    payoutEmail: string;
    isDemo: boolean;
  }>(
    `SELECT id, name, email, payout_email AS "payoutEmail", is_demo AS "isDemo"
       FROM publishers WHERE email = $1`,
    [DEMO_PUBLISHER.email],
  );
  const row = rows[0];
  if (row && !row.isDemo) {
    throw new Error(`${DEMO_PUBLISHER.email} exists but is not a demo publisher; refusing to seed`);
  }
  return row ?? null;
}

async function upsertSite(
  db: Db,
  config: Config,
  publisherId: string,
): Promise<SeedDemoResult['site']> {
  const secret = config.SESSION_SECRET;
  const origin = normalizeOrigin(config.DEMO_SITE_URL ?? DEFAULT_DEMO_SITE_URL);
  const id = seedSiteId(origin);
  const gateKey = seedGateKey(secret, id);
  const crawlKey = deriveCrawlKey(id, secret);
  const verifyToken = config.SPIGOT_VERIFY_TOKEN ?? seedVerifyToken(secret, origin);

  const created = await db.tx(async (tx) => {
    const { rows: taken } = await tx.query<{ slug: string }>(
      `SELECT slug FROM sites WHERE slug = $1 OR slug LIKE $2`,
      [baseSlug(origin), `${baseSlug(origin).replace(/[\\%_]/g, '\\$&')}-%`],
    );
    const slug = pickSlug(
      baseSlug(origin),
      taken.map((r) => r.slug),
    );
    // No conflict target: a twin seed inserting the same id / origin / slug just finds it.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO sites (id, publisher_id, origin, slug, sitemap_url, verify_token,
                          crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VERIFIED')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        id,
        publisherId,
        origin,
        slug,
        `${origin}/sitemap.xml`,
        verifyToken,
        crawlKeyHash(crawlKey),
        sha256Hex(gateKey),
      ],
    );
    if (!rows[0]) return false;
    const actor = { actorType: 'SYSTEM' as const, publisherId, entity: 'sites', entityId: id };
    await audit(tx, {
      ...actor,
      action: 'SITE_CONNECTED',
      data: { origin, slug, sitemapUrl: `${origin}/sitemap.xml`, seed: 'seed:demo' },
    });
    await audit(tx, {
      ...actor,
      action: 'SITE_VERIFIED',
      data: { origin, method: 'preset token (seed:demo)' },
    });
    return true;
  });

  const { rows } = await db.pool.query<{
    id: string;
    publisher_id: string;
    slug: string;
    status: string;
    verify_token: string;
    gate_key_hash: string;
  }>(
    `SELECT id, publisher_id, slug, status, verify_token, gate_key_hash FROM sites WHERE origin = $1`,
    [origin],
  );
  const site = rows[0];
  if (!site) throw new Error(`seed: could not connect ${origin} (its slug may be taken)`);
  if (site.publisher_id !== publisherId) {
    throw new Error(`${origin} is connected to another publisher; refusing to seed over it`);
  }
  if (site.id !== id) throw new Error(`${origin} was connected outside the seed; reset it first`);
  return {
    id,
    origin,
    slug: site.slug,
    status: site.status,
    created,
    verify: { path: VERIFY_PATH, content: site.verify_token },
    gateKey,
    crawlKey,
    gateKeyMatches: site.gate_key_hash === sha256Hex(gateKey),
  };
}

async function upsertBuyer(
  db: Db,
  b: { name: string; email: string; simulated: boolean; password: string | null },
): Promise<SeededLogin> {
  const find = async () => {
    const { rows } = await db.pool.query<{ id: string; name: string; is_simulated: boolean }>(
      `SELECT id, name, is_simulated FROM buyers WHERE email = $1`,
      [b.email],
    );
    const row = rows[0];
    if (row && row.is_simulated !== b.simulated) {
      throw new Error(`${b.email} exists with is_simulated=${row.is_simulated}; refusing to seed`);
    }
    return row ?? null;
  };
  const existing = await find();
  if (existing)
    return {
      id: existing.id,
      name: existing.name,
      email: b.email,
      password: b.password ?? '',
      created: false,
    };
  const passwordHash = b.password ? await hashPassword(b.password) : null;
  const { rows } = await db.pool.query(
    `INSERT INTO buyers (name, email, password_hash, is_simulated)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [b.name, b.email, passwordHash, b.simulated],
  );
  const row = (await find())!;
  return {
    id: row.id,
    name: row.name,
    email: b.email,
    password: b.password ?? '',
    created: rows.length > 0,
  };
}

/** Store the derived key's hash once (`key_hash` is unique). A revoked key stays revoked. */
async function ensureKey(
  db: Db,
  buyerId: string,
  key: string,
  o: { name: string; scopes: string[]; rateLimitPerMin?: number },
): Promise<void> {
  const body = key.slice(API_KEY_PREFIX.length);
  const { rows } = await db.pool.query<{ buyer_id: string }>(
    `INSERT INTO api_keys (buyer_id, name, prefix, key_hash, scopes, rate_limit_per_min)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 60))
     ON CONFLICT (key_hash) DO NOTHING
     RETURNING buyer_id`,
    [buyerId, o.name, body.slice(0, 8), hashKey(key), o.scopes, o.rateLimitPerMin ?? null],
  );
  if (rows[0]) return;
  const { rows: found } = await db.pool.query<{ buyer_id: string }>(
    `SELECT buyer_id FROM api_keys WHERE key_hash = $1`,
    [hashKey(key)],
  );
  if (found[0] && found[0].buyer_id !== buyerId) {
    throw new Error('seed: a derived API key belongs to another buyer');
  }
}

// ---------------------------------------------------------------------------------------------
// SIM top-ups

async function seedSimBuyer(
  deps: SeedDeps,
  spec: SimBuyerSpec,
  simulatedAt: Date,
): Promise<SeededSimTopup> {
  const { db, config } = deps;
  const buyer = await upsertBuyer(db, {
    name: spec.name,
    email: spec.email,
    simulated: true,
    password: null,
  });
  const apiKey = seedApiKey(config.SESSION_SECRET, spec.email);
  await ensureKey(db, buyer.id, apiKey, {
    name: 'SIM key (seed:demo)',
    scopes: ['read'],
    rateLimitPerMin: SIM_KEY_RATE_LIMIT_PER_MIN,
  });

  const topupId = seedTopupId(spec.email);
  const base = {
    buyerId: buyer.id,
    email: spec.email,
    name: spec.name,
    apiKey,
    topupId,
    amountCents: spec.topupCents,
  };
  let out: ServerCardTopupOutcome;
  try {
    out = await serverCardTopup(deps, {
      topupId,
      buyerId: buyer.id,
      amountCents: spec.topupCents,
      trigger: 'SIM',
      simulatedAt,
    });
  } catch (err) {
    // `PAYPAL_ERROR` from a reconciling GET: nothing decided, the next run settles it. The other
    // buyers carry on. Anything else (IDEMPOTENCY_MISMATCH, a bug) stops the seed.
    if (!(err instanceof ApiError) || err.code !== 'PAYPAL_ERROR') throw err;
    const row = await topupById(db, topupId);
    return {
      ...base,
      status: 'ERROR',
      created: false,
      paypalOrderId: row?.paypalOrderId ?? null,
      paypalCaptureId: row?.paypalCaptureId ?? null,
      code: err.code,
    };
  }

  let row: TopupRow = out.topup;
  if (out.status === 'NEEDS_RECONCILE' && isRateLimited(row)) {
    const fallback = await ledgerOnlySimTopup(db, topupId, simulatedAt);
    if (fallback) {
      return {
        ...base,
        status: 'LEDGER_ONLY',
        created: out.created,
        paypalOrderId: null,
        paypalCaptureId: null,
        code: row.errorCode,
      };
    }
    row = (await topupById(db, topupId)) ?? row;
  }
  return {
    ...base,
    status: row.status === 'COMPLETED' && row.paypalOrderId === null ? 'LEDGER_ONLY' : out.status,
    created: out.created,
    paypalOrderId: row.paypalOrderId,
    paypalCaptureId: row.paypalCaptureId,
    code: 'code' in out ? out.code : null,
  };
}

/** Our create got a 429 and PayPal never gave us an order: no money moved at PayPal. */
function isRateLimited(row: TopupRow): boolean {
  return (
    row.status === 'CREATED' &&
    row.paypalOrderId === null &&
    row.errorCode !== null &&
    RATE_LIMIT_CODES.has(row.errorCode)
  );
}

/**
 * features/15 §Seed 6 fallback: complete the rate-limited SIM top-up on the ledger only. Same row
 * (same deterministic id), `paypal_order_id` and `paypal_capture_id` stay null, the TOPUP txn is
 * simulated and dated like the others, and the audit row carries the "SIM (no PayPal)" label.
 * Returns false when the row was settled meanwhile (a racing run): nothing written.
 */
export async function ledgerOnlySimTopup(
  db: Db,
  topupId: string,
  simulatedAt: Date,
): Promise<boolean> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1 FOR UPDATE`,
      [topupId],
    );
    const topup = rows[0];
    if (!topup || topup.trigger !== 'SIM' || !isRateLimited(topup)) return false;

    const completed = await transition<'topups', Record<string, unknown>>(
      tx,
      'topups',
      topup.id,
      'CREATED',
      'COMPLETED',
      { needs_reconcile: false, updated_at: new Date() },
    );
    if (!completed) return false;

    const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', topup.buyerId);
    const paypalCash = await getOrCreateAccount(tx, 'PAYPAL_CASH');
    const posted = await post(tx, {
      kind: 'TOPUP',
      idempotencyKey: `topup:${topup.id}`,
      refType: 'topup',
      refId: topup.id,
      memo: SIM_NO_PAYPAL_LABEL,
      entries: topupEntries({ buyer, paypalCash }, centsToMicros(topup.amountCents)),
      isSimulated: true,
      simulatedAt,
    });
    await tx.query(`UPDATE topups SET ledger_txn_id = $2 WHERE id = $1`, [topup.id, posted.txn.id]);
    await audit(tx, {
      actorType: 'SIM',
      actorId: topup.buyerId,
      entity: 'topups',
      entityId: topup.id,
      action: 'TOPUP_COMPLETED',
      data: {
        orderId: null,
        captureId: null,
        amountCents: topup.amountCents,
        ledgerTxnId: posted.txn.id,
        ledgerOnly: true,
        label: SIM_NO_PAYPAL_LABEL,
        reason: topup.errorCode,
      },
    });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// --with-proposals

/**
 * Replay the recorded proposal (SP-012a recorded mode; persist audits it "replayed proposal").
 * Needs a crawled site (PROPOSING / READY): the discovery crawl is never seeded.
 */
async function replayProposals(db: Db, siteId: string): Promise<SeedDemoResult['proposals']> {
  const { rows } = await db.pool.query<{ status: string }>(
    `SELECT status FROM sites WHERE id = $1`,
    [siteId],
  );
  const status = rows[0]?.status;
  if (status !== 'PROPOSING' && status !== 'READY') {
    return {
      status: 'skipped',
      reason: `the site is ${status ?? 'missing'}: run the discovery crawl first (POST /api/sites/${siteId}/crawl), then re-run with --with-proposals`,
    };
  }
  const result = await proposeForSite({ db, model: createRecordedModel() }, siteId, {
    trigger: 'ADMIN',
  });
  return { status: 'ran', result };
}
