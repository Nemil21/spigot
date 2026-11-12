import { isDeepStrictEqual } from 'node:util';
import { audit } from '../audit/audit.js';
import type { Config } from '../config.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { fetchPage, type FetchPageResult } from '../crawl/fetchPage.js';
import { emitRunEnding, emitRunFinished } from '../crawl/hooks.js';
import { transition, tryAdvisoryLock, type AdvisoryLock, type Db } from '../db/index.js';
import { extractPage } from '../extract/extractPage.js';
import { publishWatermark } from '../extract/publishWatermark.js';
import { dataAtHash, parseServedKeys, type ClaimReason, type VersionRow } from './checks.js';
import {
  createClaim,
  schemaAtCall,
  type ClaimInput,
  type ClaimResult,
  type ClaimStatus,
} from './create.js';
import { creditClaim, lockBuyer } from './credit.js';

/**
 * `STALE` / `REMOVED` claims (features/10 §Claims 2; SP-048c): one targeted `fetchPage` of the
 * record's source page (crawl key, SSRF-guarded through `safeFetch`), then `extractPage` +
 * `publishWatermark`, so whatever changed lands in the changes feed as usual. Then:
 * - the page is gone (404 / 410, or the page / record is already removed), or the record as it is
 *   now differs from the version the call served on a **visible** field → `AUTO_CREDITED`
 *   through SP-048a's credit path (abuse limit included);
 * - it matches, or the fetch failed → stays `OPEN` for the publisher (SP-048b).
 *
 * The fetch runs in its own `crawl_runs` row (`trigger = CLAIM`, which may overlap a live crawl,
 * like APPROVE) and goes through the crawl hooks like any run: `onPageChanged` (extraction and
 * SP-052a's drift probe), `onRunEnding`, `onRunFinished` (watermark, CRAWL_RUN_DONE audit). The
 * explicit `extractPage` + `publishWatermark` make the result independent of which hooks a
 * process registered; both are idempotent.
 *
 * Rate limit: one re-fetch per record per 10 minutes (`record_refetches`). Re-fetches of one
 * record are serialized on the `claim-refetch:<recordId>` advisory lock, so the same claim sent
 * over MCP and REST at once fetches once: the second waits, then reuses the first's result.
 * Crediting re-checks the claim is still OPEN under the buyer lock, so it posts one CREDIT.
 */

export const REFETCH_REASONS: ReadonlySet<ClaimReason> = new Set(['STALE', 'REMOVED']);
/** A repeat claim within this window reuses the record's last re-fetch. */
export const REFETCH_WINDOW_MS = 10 * 60_000;
/** The claim request waits at most this long for the page (no retries: one request). */
export const REFETCH_TIMEOUT_MS = 20_000;
/** How long a second claim waits for a re-fetch of the same record already in flight. */
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 50;

export type RefetchOutcome = 'FETCHED' | 'GONE' | 'FAILED';

export interface RefetchResult {
  outcome: RefetchOutcome;
  /** The CLAIM run that fetched (null when nothing was fetched: page already removed, or none). */
  runId: string | null;
  httpStatus: number | null;
  /** True when this claim reused a re-fetch made in the last 10 minutes. */
  reused: boolean;
}

export interface ClaimDeps {
  db: Db;
  /** For the targeted fetch: crawl key secret, SSRF settings, host queue gap. */
  crawl: CrawlDeps;
  now?: () => Date;
}

/** Claim deps from the app's config, like the crawl routes build theirs. */
export function claimDeps(db: Db, config: Config, signal?: AbortSignal): ClaimDeps {
  return {
    db,
    crawl: {
      db,
      crawlSecret: config.SESSION_SECRET,
      allowLocal: config.ALLOW_LOCAL_ORIGINS,
      appBaseUrl: config.APP_BASE_URL,
      // Same rule as routes/crawl.ts: only an explicit CRAWL_MIN_GAP_MS overrides the adaptive gap.
      minGapMs: process.env.CRAWL_MIN_GAP_MS?.trim() ? config.CRAWL_MIN_GAP_MS : undefined,
      ...(signal ? { signal } : {}),
    },
  };
}

/**
 * `POST /v1/claims` and MCP `report_bad_record`: SP-048a's `createClaim`, then (after it
 * committed) the targeted re-fetch for a STALE / REMOVED claim that is still OPEN. A resend of a
 * claim decided earlier returns it as it is.
 */
export async function submitClaim(deps: ClaimDeps, input: ClaimInput): Promise<ClaimResult> {
  const created = await createClaim({ db: deps.db, now: deps.now }, input);
  if (created.status !== 'OPEN') return created;
  return refetchCheck(deps, {
    claimId: created.claimId,
    buyerId: input.buyerId,
    actorType: input.actorType ?? 'BUYER',
  });
}

interface ClaimContext {
  id: string;
  status: ClaimStatus;
  reason: ClaimReason;
  creditMicros: number | null;
  recordId: string;
  recordKey: string;
  pageId: string | null;
  datasetId: string;
  siteId: string;
  publisherId: string;
  callId: string;
  callCreatedAt: Date;
  servedRecordKeys: unknown;
  datasetSlug: string;
  activeSchemaId: string | null;
}

const asResult = (c: Pick<ClaimContext, 'id' | 'status' | 'creditMicros'>): ClaimResult => ({
  claimId: c.id,
  status: c.status,
  creditMicros: c.creditMicros ?? 0,
});

/** Run the STALE / REMOVED check for an OPEN claim of `buyerId`. Anything else: returned as is. */
export async function refetchCheck(
  deps: ClaimDeps,
  args: { claimId: string; buyerId: string; actorType: 'BUYER' | 'MCP_CLIENT' },
): Promise<ClaimResult> {
  const { db } = deps;
  const claim = (
    await db.pool.query<ClaimContext>(
      `SELECT c.id, c.status, c.reason, c.credit_micros AS "creditMicros",
              r.id AS "recordId", r.record_key AS "recordKey", r.page_id AS "pageId",
              r.dataset_id AS "datasetId", d.site_id AS "siteId", s.publisher_id AS "publisherId",
              a.id AS "callId", a.created_at AS "callCreatedAt",
              a.served_record_keys AS "servedRecordKeys", d.slug AS "datasetSlug",
              d.active_schema_id AS "activeSchemaId"
         FROM claims c
         JOIN records r ON r.id = c.record_id
         JOIN datasets d ON d.id = r.dataset_id
         JOIN sites s ON s.id = d.site_id
         JOIN api_calls a ON a.id = c.api_call_id
        WHERE c.id = $1 AND c.buyer_id = $2`,
      [args.claimId, args.buyerId],
    )
  ).rows[0];
  if (!claim) throw new Error(`refetchCheck: claim ${args.claimId} not found`);
  if (claim.status !== 'OPEN' || !REFETCH_REASONS.has(claim.reason)) return asResult(claim);

  const refetch = await refetchRecord(deps, claim);
  if (!refetch) return asResult(claim); // another re-fetch of this record is stuck: leave it OPEN

  return db.tx(async (tx) => {
    if (!(await lockBuyer(tx, args.buyerId))) return asResult(claim);
    const now = (
      await tx.query<{ status: ClaimStatus; creditMicros: number | null }>(
        `SELECT status, credit_micros AS "creditMicros" FROM claims WHERE id = $1 FOR UPDATE`,
        [claim.id],
      )
    ).rows[0]!;
    // A racing request for the same claim decided it while we waited for the buyer lock.
    if (now.status !== 'OPEN') return asResult({ id: claim.id, ...now });

    const check = await compare(tx, claim, refetch);
    if (!check.confirmed) return asResult({ id: claim.id, ...now });

    const credit = await creditClaim(tx, {
      claimId: claim.id,
      callId: claim.callId,
      buyerId: args.buyerId,
      publisherId: claim.publisherId,
    });
    if (!credit.credited) return asResult({ id: claim.id, ...now });

    await transition(tx, 'claims', claim.id, 'OPEN', 'AUTO_CREDITED', {
      credit_micros: credit.creditMicros,
      decided_by: 'AUTO',
      ledger_txn_id: credit.ledgerTxnId,
    });
    await audit(tx, {
      actorType: args.actorType,
      actorId: args.buyerId,
      publisherId: claim.publisherId,
      entity: 'claims',
      entityId: claim.id,
      action: 'CLAIM_DECIDED',
      data: {
        callId: claim.callId,
        reason: claim.reason,
        status: 'AUTO_CREDITED',
        decidedBy: 'AUTO',
        creditMicros: credit.creditMicros,
        ledgerTxnId: credit.ledgerTxnId,
        callStatus: credit.callStatus,
        check: check.detail,
      },
    });
    return { claimId: claim.id, status: 'AUTO_CREDITED', creditMicros: credit.creditMicros };
  });
}

/** The schema's `visible: true` field names (`schema_versions.fields` as stored). */
export function visibleFields(storedFields: unknown): string[] {
  if (!Array.isArray(storedFields)) return [];
  return storedFields
    .filter(
      (f): f is { name: string } =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as { name?: unknown }).name === 'string' &&
        (f as { visible?: unknown }).visible === true,
    )
    .map((f) => f.name);
}

/** Visible fields whose value differs between the served record and the record now. */
export function changedVisibleFields(
  served: unknown,
  current: unknown,
  fields: readonly string[],
): string[] {
  const obj = (v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const a = obj(served);
  const b = obj(current);
  return fields.filter((f) => !isDeepStrictEqual(a[f] ?? null, b[f] ?? null));
}

type Check = { confirmed: boolean; detail: Record<string, unknown> };

/** Served version vs the record after the re-fetch. Runs under the buyer + claim locks. */
async function compare(
  tx: Parameters<typeof schemaAtCall>[0],
  claim: ClaimContext,
  refetch: RefetchResult,
): Promise<Check> {
  const base = {
    check: 'REFETCH',
    outcome: refetch.outcome,
    runId: refetch.runId,
    httpStatus: refetch.httpStatus,
    reused: refetch.reused,
  };
  const rec = (
    await tx.query<{ data: unknown; removedAt: Date | null }>(
      `SELECT data, removed_at AS "removedAt" FROM records WHERE id = $1`,
      [claim.recordId],
    )
  ).rows[0];
  if (refetch.outcome === 'GONE' || rec?.removedAt) {
    return { confirmed: true, detail: { ...base, gone: true } };
  }
  if (refetch.outcome === 'FAILED' || !rec) return { confirmed: false, detail: base };

  const key = `${claim.datasetSlug}/${claim.recordKey}`;
  const hash = parseServedKeys(claim.servedRecordKeys).find((s) => s.key === key)?.hash;
  const versions = (
    await tx.query<VersionRow>(
      `SELECT version, op, patch, hash FROM record_versions WHERE record_id = $1 ORDER BY version`,
      [claim.recordId],
    )
  ).rows;
  const served = hash === undefined ? null : dataAtHash(versions, hash);
  // The served version can't be rebuilt (e.g. a changes-feed call): nothing to compare.
  if (served === null) return { confirmed: false, detail: { ...base, served: false } };

  const fields = visibleFields(
    await schemaAtCall(tx, {
      datasetId: claim.datasetId,
      createdAt: claim.callCreatedAt,
      activeSchemaId: claim.activeSchemaId,
    }),
  );
  if (fields.length === 0) return { confirmed: false, detail: { ...base, fields: 0 } };
  const changed = changedVisibleFields(served, rec.data, fields);
  return { confirmed: changed.length > 0, detail: { ...base, changed } };
}

/**
 * The record's re-fetch: the last one if it is under 10 minutes old, else a new one. Serialized
 * per record; waiters poll the lock so they hold no pool connection while the holder fetches.
 * `null`: the lock wasn't free within a minute.
 */
export async function refetchRecord(
  deps: ClaimDeps,
  rec: Pick<ClaimContext, 'recordId' | 'pageId' | 'datasetId' | 'siteId'>,
): Promise<RefetchResult | null> {
  const { db } = deps;
  const lock = await waitForLock(db, `claim-refetch:${rec.recordId}`);
  if (!lock) return null;
  try {
    const prior = (
      await db.pool.query<{
        outcome: RefetchOutcome;
        runId: string | null;
        httpStatus: number | null;
      }>(
        `SELECT outcome, crawl_run_id AS "runId", http_status AS "httpStatus"
           FROM record_refetches
          WHERE record_id = $1 AND fetched_at > now() - make_interval(secs => $2::double precision / 1000)`,
        [rec.recordId, REFETCH_WINDOW_MS],
      )
    ).rows[0];
    if (prior) return { ...prior, reused: true };

    const result = await fetchOnce(deps, rec);
    await db.pool.query(
      `INSERT INTO record_refetches (record_id, crawl_run_id, outcome, http_status, fetched_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (record_id) DO UPDATE
         SET crawl_run_id = EXCLUDED.crawl_run_id, outcome = EXCLUDED.outcome,
             http_status = EXCLUDED.http_status, fetched_at = EXCLUDED.fetched_at`,
      [rec.recordId, result.runId, result.outcome, result.httpStatus],
    );
    return { ...result, reused: false };
  } finally {
    await lock.release();
  }
}

async function waitForLock(db: Db, name: string): Promise<AdvisoryLock | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const lock = await tryAdvisoryLock(db.pool, name);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

const OUTCOME: Record<FetchPageResult['outcome'], RefetchOutcome> = {
  changed: 'FETCHED',
  unchanged: 'FETCHED',
  not_modified: 'FETCHED',
  gone_once: 'GONE',
  removed: 'GONE',
  failed: 'FAILED',
  paused: 'FAILED',
  skipped: 'FAILED',
};

/** One CLAIM run: fetch the page once, extract it, end the run, publish the watermark. */
async function fetchOnce(
  deps: ClaimDeps,
  rec: Pick<ClaimContext, 'pageId' | 'datasetId' | 'siteId'>,
): Promise<Omit<RefetchResult, 'reused'>> {
  const { db } = deps;
  const page = rec.pageId
    ? (
        await db.pool.query<{ removedAt: Date | null }>(
          'SELECT removed_at AS "removedAt" FROM pages WHERE id = $1',
          [rec.pageId],
        )
      ).rows[0]
    : undefined;
  // No source page to check (hand-made / seeded records): nothing Spigot can confirm.
  if (!rec.pageId || !page) return { outcome: 'FAILED', runId: null, httpStatus: null };
  // The crawler already saw the page go (404 / 410 twice): nothing to fetch.
  if (page.removedAt) return { outcome: 'GONE', runId: null, httpStatus: null };

  const runId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO crawl_runs (site_id, trigger, status, started_at, pages_total, workflow_run_id)
       VALUES ($1, 'CLAIM', 'RUNNING', now(), 1, 'inproc:claim')
       RETURNING id`,
      [rec.siteId],
    )
  ).rows[0]!.id;

  let res: FetchPageResult;
  let error: string | undefined;
  try {
    const timeout = AbortSignal.timeout(REFETCH_TIMEOUT_MS);
    res = await fetchPage(
      { pageId: rec.pageId, runId },
      {
        ...deps.crawl,
        db,
        // "One request": no 1 s / 4 s / 16 s retries while the buyer waits.
        retryDelaysMs: [],
        signal: deps.crawl.signal ? AbortSignal.any([deps.crawl.signal, timeout]) : timeout,
      },
    );
  } catch (err) {
    res = { outcome: 'failed', error: (err as Error).message };
  }
  if (res.error) error = res.error;

  try {
    // Pages the drift probe held for this run are probed and written now (SP-052a).
    await emitRunEnding(runId);
    if (res.outcome === 'changed' || res.outcome === 'unchanged' || res.outcome === 'removed') {
      const ex = await extractPage({ pageId: rec.pageId, datasetId: rec.datasetId, runId }, { db });
      if (ex.skipped) error = error ?? `Extraction skipped: ${ex.skipped}`;
    }
  } catch (err) {
    error = `Extraction failed: ${(err as Error).message}`;
  }

  const outcome = OUTCOME[res.outcome];
  const ended = await db.tx((tx) =>
    transition(tx, 'crawl_runs', runId, 'RUNNING', outcome === 'FAILED' ? 'FAILED' : 'SUCCEEDED', {
      finished_at: new Date(),
      error: error ?? null,
    }),
  );
  if (ended) await emitRunFinished(runId);
  await publishWatermark({ datasetId: rec.datasetId }, { db });
  return { outcome, runId, httpStatus: res.status ?? null };
}
