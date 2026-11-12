// `npm run demo:reset` (SP-038; features/12 §Pieces 4, features/15 §Demo hooks).
//
// Every take starts clean, and nothing is deleted. For the `is_demo` publisher and Acme only:
//  1. Its LIVE / LIVE_STALE / UNPUBLISHED datasets → PROPOSED through the `DEMO_RESET` transition
//     (data-model §Dataset state machine; refused for a publisher without `is_demo`). Records are
//     kept. A copy of the active schema is added as a new PROPOSED version, so W05 shows the
//     proposal and the on-camera approve has something to approve. `bumpPolicyVersion` in the
//     same transaction: the gate stops quoting `/listings/` on its next refresh, and the buyer API
//     answers 410 until the re-approve (`services/lookup.ts`).
//  2. Acme's balance → $0 with one `DEMO_RESET` ledger txn into `PLATFORM_REVENUE`, memo
//     "demo reset". Entries are never deleted, so the ledger check keeps passing.
//  3. Acme's foreground `api_calls` get `hidden_at = now()`, never deleted: deleting would free
//     `(api_key_id, idempotency_key)` (a replay would charge again) and break
//     `ledger_txns.ref_id` / `claims.api_call_id`.
//  4. Acme's keys are revoked and one new key is issued (printed once), so the next take starts
//     with no idempotency collisions and a replay with the old key is a 401, never a charge.
//  5. After COMMIT: `POST {DEMO_SITE_URL}/admin/reset` (SP-004b, `DEMO_ADMIN_TOKEN`; works against
//     the Render service too), then a MANUAL crawl so Spigot sees the reverted pages.
// SIM buyers, SIM calls, top-ups, payouts and every PayPal id are untouched.
//
// Steps 1–4 are one transaction under an advisory lock: two resets at once run one after the
// other, and the second finds a $0 balance and nothing left to hide.
import { randomUUID } from 'node:crypto';
import { audit } from '../audit/audit.js';
import { createKey, type ApiKeyScope } from '../auth/apiKeys.js';
import type { Config } from '../config.js';
import { requestCrawl } from '../crawl/api.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { transition, withAdvisoryXactLock, type Db, type Queryable } from '../db/index.js';
import { bumpPolicyVersion } from '../gate/policy.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { DEMO_BUYER, DEMO_PUBLISHER } from './seedDemo.js';

/** Dataset statuses the `DEMO_RESET` transition leaves (data-model §Dataset state machine). */
export const DEMO_RESETTABLE = ['LIVE', 'LIVE_STALE', 'UNPUBLISHED'] as const;

/** The ledger memo W14 / the README show for the reset txn. */
export const DEMO_RESET_MEMO = 'demo reset';

/** The name and scopes of the key issued to Acme (what seed:demo gives it). */
export const DEMO_KEY_NAME = 'Claude Desktop (demo)';
const DEMO_KEY_SCOPES: ApiKeyScope[] = ['read', 'topup'];

const LOCK = 'demo-reset';

/** A refusal: nothing was changed. The CLI prints the message and exits 1. */
export class DemoResetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoResetRefused';
  }
}

/** `demo:reset` and `demo:payout` are demo controls: refuse unless `DEMO_MODE=true`. */
export function assertDemoMode(config: Pick<Config, 'DEMO_MODE'>, command: string): void {
  if (!config.DEMO_MODE) {
    throw new DemoResetRefused(`${command} is a demo control: set DEMO_MODE=true to run it.`);
  }
}

export interface DemoResetOptions {
  /** Default: the seeded demo publisher. Must have `is_demo = true`. */
  publisherEmail?: string;
  /** Default: Acme. Must be a foreground (not simulated) buyer. */
  buyerEmail?: string;
}

export interface ResetDataset {
  id: string;
  siteId: string;
  slug: string;
  from: string;
  /** The PROPOSED schema version the re-approve takes (null: there was no schema to copy). */
  proposedSchemaVersionId: string | null;
}

export interface DemoResetResult {
  resetId: string;
  publisher: { id: string; email: string };
  datasets: ResetDataset[];
  /** `sites.policy_version` after the bump, per site touched. */
  policyVersions: Record<string, number>;
  buyer: {
    id: string;
    email: string;
    /** Balance moved to platform revenue (0: already $0, no txn). */
    zeroedMicros: number;
    ledgerTxnId: string | null;
    hiddenCalls: number;
    revokedKeyIds: string[];
    /** The new key, in clear: the only time it exists. */
    apiKey: string;
    apiKeyId: string;
  };
}

interface PublisherRow {
  id: string;
  email: string;
  is_demo: boolean;
}

/** Steps 1–4 (database only). Throws `DemoResetRefused` before writing anything. */
export async function demoReset(db: Db, opts: DemoResetOptions = {}): Promise<DemoResetResult> {
  const publisherEmail = opts.publisherEmail ?? DEMO_PUBLISHER.email;
  const buyerEmail = opts.buyerEmail ?? DEMO_BUYER.email;
  const resetId = randomUUID();

  return db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, LOCK);

    const publisher = (
      await tx.query<PublisherRow>(
        'SELECT id, email, is_demo FROM publishers WHERE email = $1 FOR UPDATE',
        [publisherEmail],
      )
    ).rows[0];
    if (!publisher) {
      throw new DemoResetRefused(`No publisher ${publisherEmail}: run seed:demo first.`);
    }
    if (!publisher.is_demo) {
      throw new DemoResetRefused(
        `${publisherEmail} is not the demo publisher (is_demo = false): demo:reset refuses to touch it.`,
      );
    }
    const buyer = (
      await tx.query<{ id: string; is_simulated: boolean }>(
        'SELECT id, is_simulated FROM buyers WHERE email = $1 FOR UPDATE',
        [buyerEmail],
      )
    ).rows[0];
    if (!buyer) throw new DemoResetRefused(`No buyer ${buyerEmail}: run seed:demo first.`);
    if (buyer.is_simulated) {
      throw new DemoResetRefused(`${buyerEmail} is a SIM buyer: SIM history is never reset.`);
    }

    // 1. Datasets → PROPOSED, then one policy bump per site.
    const datasets = await resetDatasets(tx, publisher);
    const policyVersions: Record<string, number> = {};
    for (const siteId of new Set(datasets.map((d) => d.siteId))) {
      policyVersions[siteId] = await bumpPolicyVersion(tx, siteId);
    }

    // 2. Acme's balance → $0 into platform revenue. Lock both accounts in id order, like
    // `ledger.post`, so a charge racing the reset can't deadlock with it; the amount is read
    // under the lock.
    const buyerAccount = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer.id);
    const revenue = await getOrCreateAccount(tx, 'PLATFORM_REVENUE');
    const { rows: locked } = await tx.query<{ id: string; balance: string }>(
      `SELECT id, balance_micros AS balance FROM ledger_accounts
        WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[buyerAccount, revenue]],
    );
    const balance = Number(locked.find((r) => r.id === buyerAccount)!.balance);
    let ledgerTxnId: string | null = null;
    if (balance > 0) {
      const posted = await post(tx, {
        kind: 'DEMO_RESET',
        idempotencyKey: `demo_reset:${resetId}:${buyer.id}`,
        refType: 'buyers',
        refId: buyer.id,
        memo: DEMO_RESET_MEMO,
        entries: [
          { accountId: buyerAccount, amountMicros: -balance },
          { accountId: revenue, amountMicros: balance },
        ],
      });
      ledgerTxnId = posted.txn.id;
    }

    // 3. Hide Acme's calls (foreground only; a SIM call never belongs to Acme anyway).
    const hidden = await tx.query(
      `UPDATE api_calls SET hidden_at = now(), updated_at = now()
        WHERE buyer_id = $1 AND hidden_at IS NULL AND NOT is_simulated`,
      [buyer.id],
    );

    // 4. Rotate: revoke every live key, issue one new key.
    const { rows: revoked } = await tx.query<{ id: string }>(
      `UPDATE api_keys SET revoked_at = now(), updated_at = now()
        WHERE buyer_id = $1 AND revoked_at IS NULL RETURNING id`,
      [buyer.id],
    );
    const key = await createKey(tx, buyer.id, { name: DEMO_KEY_NAME, scopes: DEMO_KEY_SCOPES });

    const result: DemoResetResult = {
      resetId,
      publisher: { id: publisher.id, email: publisher.email },
      datasets,
      policyVersions,
      buyer: {
        id: buyer.id,
        email: buyerEmail,
        zeroedMicros: Math.max(balance, 0),
        ledgerTxnId,
        hiddenCalls: hidden.rowCount ?? 0,
        revokedKeyIds: revoked.map((r) => r.id),
        apiKey: key.key,
        apiKeyId: key.id,
      },
    };
    await audit(tx, {
      actorType: 'SYSTEM',
      actorId: 'demo:reset',
      publisherId: publisher.id,
      entity: 'publishers',
      entityId: publisher.id,
      action: 'DEMO_RESET',
      data: {
        resetId,
        datasets: datasets.map((d) => ({ id: d.id, slug: d.slug, from: d.from })),
        policyVersions,
        buyerId: buyer.id,
        zeroedMicros: result.buyer.zeroedMicros,
        ledgerTxnId,
        hiddenCalls: result.buyer.hiddenCalls,
        revokedKeyIds: result.buyer.revokedKeyIds,
        newKeyId: key.id,
        newKeyPrefix: key.prefix,
      },
    });
    return result;
  });
}

/**
 * The `DEMO_RESET` dataset transition. The `is_demo` check lives here too, so no caller can take
 * the transition for a real publisher (the row is locked by `demoReset`).
 */
async function resetDatasets(tx: Queryable, publisher: PublisherRow): Promise<ResetDataset[]> {
  if (!publisher.is_demo) throw new DemoResetRefused('DEMO_RESET is only for an is_demo publisher');
  const { rows } = await tx.query<{
    id: string;
    site_id: string;
    slug: string;
    status: string;
    active_schema_id: string | null;
  }>(
    `SELECT d.id, d.site_id, d.slug, d.status, d.active_schema_id
       FROM datasets d JOIN sites s ON s.id = d.site_id
      WHERE s.publisher_id = $1 AND d.status = ANY($2::text[])
      ORDER BY d.id
      FOR UPDATE OF d`,
    [publisher.id, DEMO_RESETTABLE],
  );
  const out: ResetDataset[] = [];
  for (const d of rows) {
    const moved = await transition(tx, 'datasets', d.id, [...DEMO_RESETTABLE], 'PROPOSED', {
      stale_since: null,
      updated_at: new Date(),
    });
    if (!moved) continue;
    out.push({
      id: d.id,
      siteId: d.site_id,
      slug: d.slug,
      from: d.status,
      proposedSchemaVersionId: await reproposeSchema(tx, d.id, d.active_schema_id),
    });
  }
  return out;
}

/**
 * A PROPOSED copy of the active schema (the approve route only approves a PROPOSED version).
 * `active_schema_id` stays set: it is how the buyer API tells a reset dataset (410) from one that
 * was never published (404). An existing PROPOSED version is reused.
 */
async function reproposeSchema(
  tx: Queryable,
  datasetId: string,
  activeSchemaId: string | null,
): Promise<string | null> {
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM schema_versions WHERE dataset_id = $1 AND status = 'PROPOSED'
      ORDER BY version DESC LIMIT 1`,
    [datasetId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  if (!activeSchemaId) return null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO schema_versions
       (dataset_id, version, status, fields, extractor, record_key, sample_stats, ai_model,
        ai_rationale, proposed_by)
     SELECT sv.dataset_id,
            (SELECT max(version) + 1 FROM schema_versions WHERE dataset_id = sv.dataset_id),
            'PROPOSED', sv.fields, sv.extractor, sv.record_key, sv.sample_stats, sv.ai_model,
            sv.ai_rationale, sv.proposed_by
       FROM schema_versions sv
      WHERE sv.id = $1 AND sv.dataset_id = $2
     RETURNING id`,
    [activeSchemaId, datasetId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Step 5: the demo site and the crawl

export interface DemoSiteResetResult {
  at: string;
  reverted: string[];
  removed: string[];
}

/**
 * `POST {siteUrl}/admin/reset` with `DEMO_ADMIN_TOKEN` (SP-004b). Works against any reachable
 * demo site (localhost or the Render service). Throws with the status on anything but a 2xx.
 */
export async function resetDemoSite(
  siteUrl: string,
  token: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DemoSiteResetResult> {
  const url = new URL('/admin/reset', siteUrl);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new Error(
      `${url.origin}/admin/reset unreachable (${cause ?? (err as Error).message}): is the demo site running at DEMO_SITE_URL?`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Partial<DemoSiteResetResult> & {
    error?: string;
  };
  if (!res.ok) {
    const hint =
      res.status === 401
        ? ' (DEMO_ADMIN_TOKEN does not match the demo site)'
        : res.status === 404
          ? ' (is DEMO_ADMIN_TOKEN set on the demo site?)'
          : '';
    throw new Error(`${url.origin}/admin/reset → ${res.status}${hint}`);
  }
  return { at: String(body.at), reverted: body.reverted ?? [], removed: body.removed ?? [] };
}

/** The demo publisher's site for `origin` (the seeded one), or null. */
export async function demoSiteOf(
  q: Queryable,
  publisherId: string,
  origin: string,
): Promise<{ id: string; status: string } | null> {
  const { rows } = await q.query<{ id: string; status: string }>(
    'SELECT id, status FROM sites WHERE publisher_id = $1 AND origin = $2',
    [publisherId, origin],
  );
  return rows[0] ?? null;
}

/**
 * A MANUAL crawl of the demo site, run in this process; resolves when the run ends. The caller
 * registers the same crawl hooks the API process does (extraction, audit).
 */
export async function crawlDemoSite(
  deps: CrawlDeps,
  publisherId: string,
  siteId: string,
): Promise<{ crawlRunId: string; status: string }> {
  let done: Promise<unknown> = Promise.resolve();
  const started = await requestCrawl(
    deps,
    publisherId,
    siteId,
    { trigger: 'MANUAL' },
    (d) => (done = d),
  );
  await done;
  const { rows } = await deps.db.pool.query<{ status: string }>(
    'SELECT status FROM crawl_runs WHERE id = $1',
    [started.crawlRunId],
  );
  return { crawlRunId: started.crawlRunId, status: rows[0]?.status ?? 'UNKNOWN' };
}
