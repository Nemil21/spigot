import type pg from 'pg';
import type { Config } from '../config.js';
import { PayPalApiError } from '../paypal/errors.js';
import { lastLedgerCheck, type LedgerCheckTrigger } from './ledgerStatus.js';

/**
 * `GET /admin/health` (api.md §Ops; features/14 §Audit and ops; SP-043). Three dependency checks
 * (PayPal token, DB, Workflows) decide `status`; the rest are facts for the W14 tiles (last gate
 * hit per site, open top-ups, pending payout items). The latest recorded ledger check (nightly or
 * admin, SP-061) also counts: a mismatch keeps health degraded until a clean check. Each check has
 * its own timeout, so one hung
 * dependency marks itself failed instead of hanging the endpoint. Failures carry an error code
 * only, never a message that could echo a credential.
 */

export interface CheckResult {
  ok: boolean;
  ms: number;
  /** Short machine code when `ok` is false (`TIMEOUT`, PayPal's error code, …). */
  error?: string;
}

export interface WorkflowsCheck {
  ok: boolean;
  mode: Config['WORKFLOWS_MODE'];
  /** `inproc`: not used. `workflows`: the Render keys are set (no live Render call yet). */
  detail: string;
  missing?: string[];
}

export interface LedgerStatusCheck extends CheckResult {
  /** When the latest recorded check ran; `null` if none has yet (that alone is not degraded). */
  lastCheckedAt: string | null;
  trigger: LedgerCheckTrigger | null;
  /** Mismatches the latest check found (`error: 'LEDGER_MISMATCH'` when > 0). */
  mismatches: number | null;
}

export interface SiteGate {
  siteId: string;
  publisherId: string;
  origin: string;
  status: string;
  /** `sites.last_gate_seen_at`: the gate's last policy fetch / hit flush. */
  lastGateSeenAt: string | null;
  /** Latest `bot_hits` minute bucket for the site. */
  lastHitAt: string | null;
}

export interface AdminHealth {
  status: 'ok' | 'degraded';
  checkedAt: string;
  checks: {
    paypal: CheckResult;
    db: CheckResult;
    workflows: WorkflowsCheck;
    ledger: LedgerStatusCheck;
    /** The tile queries below (`DB_UNAVAILABLE` when the DB check already failed). */
    facts: CheckResult;
  };
  /** The tiles below are `null` when the `facts` check failed. */
  gate: SiteGate[] | null;
  openTopups: { count: number; oldestAt: string | null; needsReconcile: number } | null;
  pendingPayouts: {
    pendingItems: number;
    unclaimedItems: number;
    oldestAt: string | null;
    batchesNeedingReconcile: number;
  } | null;
}

export interface HealthDeps {
  pool: pg.Pool;
  config: Pick<Config, 'WORKFLOWS_MODE' | 'RENDER_API_KEY' | 'RENDER_WORKFLOWS_SERVICE_ID'>;
  /** Mints a PayPal OAuth token (the route passes a fresh client, so this is a real mint). */
  paypalToken: () => Promise<string>;
  /** Per-check timeout. Default 5 s. */
  timeoutMs?: number;
}

class CheckTimeout extends Error {}

async function timed<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ check: CheckResult; value?: T }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
      }),
    ]);
    return { check: { ok: true, ms: Math.round(performance.now() - started) }, value };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { check: { ok: false, ms, error: errorCode(err) } };
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(err: unknown): string {
  if (err instanceof CheckTimeout) return 'TIMEOUT';
  if (err instanceof PayPalApiError) return err.code || `HTTP_${err.http}`;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'ERROR';
}

function workflowsCheck(config: HealthDeps['config']): WorkflowsCheck {
  if (config.WORKFLOWS_MODE !== 'workflows') {
    return { ok: true, mode: config.WORKFLOWS_MODE, detail: 'not used (in-process jobs)' };
  }
  const missing = (['RENDER_API_KEY', 'RENDER_WORKFLOWS_SERVICE_ID'] as const).filter(
    (k) => !config[k],
  );
  return missing.length
    ? { ok: false, mode: 'workflows', detail: 'Render Workflows keys missing', missing }
    : { ok: true, mode: 'workflows', detail: 'configured' };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function adminHealth(deps: HealthDeps): Promise<AdminHealth> {
  const timeoutMs = deps.timeoutMs ?? 5000;
  const { pool } = deps;

  const [{ check: paypal }, { check: db }] = await Promise.all([
    timed(deps.paypalToken, timeoutMs),
    timed(() => pool.query('SELECT 1'), timeoutMs),
  ]);
  const workflows = workflowsCheck(deps.config);
  // The tiles get the same timeout and error handling: the DB can drop, or the pool can be
  // saturated, after `SELECT 1` succeeded.
  const tiles = db.ok
    ? await timed(() => opsFacts(pool), timeoutMs)
    : { check: { ok: false, ms: 0, error: 'DB_UNAVAILABLE' } };
  const facts = tiles.check;
  const ledger = db.ok
    ? ledgerStatus(await timed(() => lastLedgerCheck(pool), timeoutMs))
    : ledgerStatus({ check: { ok: false, ms: 0, error: 'DB_UNAVAILABLE' } });

  return {
    status: paypal.ok && db.ok && workflows.ok && ledger.ok && facts.ok ? 'ok' : 'degraded',
    checkedAt: new Date().toISOString(),
    checks: { paypal, db, workflows, ledger, facts },
    ...(tiles.value ?? { gate: null, openTopups: null, pendingPayouts: null }),
  };
}

function ledgerStatus({
  check,
  value,
}: {
  check: CheckResult;
  value?: Awaited<ReturnType<typeof lastLedgerCheck>>;
}): LedgerStatusCheck {
  if (!check.ok || !value) {
    return { ...check, lastCheckedAt: null, trigger: null, mismatches: null };
  }
  const base = { ms: check.ms, lastCheckedAt: value.at.toISOString(), trigger: value.trigger };
  return value.mismatches > 0
    ? { ...base, ok: false, error: 'LEDGER_MISMATCH', mismatches: value.mismatches }
    : { ...base, ok: true, mismatches: 0 };
}

async function opsFacts(
  pool: pg.Pool,
): Promise<Pick<AdminHealth, 'gate' | 'openTopups' | 'pendingPayouts'>> {
  const gate = await pool.query<{
    siteId: string;
    publisherId: string;
    origin: string;
    status: string;
    lastGateSeenAt: Date | null;
    lastHitAt: Date | null;
  }>(
    `SELECT s.id AS "siteId", s.publisher_id AS "publisherId", s.origin, s.status,
            s.last_gate_seen_at AS "lastGateSeenAt",
            (SELECT max(h.bucket) FROM bot_hits h WHERE h.site_id = s.id) AS "lastHitAt"
     FROM sites s
     ORDER BY s.created_at, s.id`,
  );
  const topups = await pool.query<{ count: number; oldestAt: Date | null; reconcile: number }>(
    `SELECT count(*)::int AS count, min(created_at) AS "oldestAt",
            count(*) FILTER (WHERE needs_reconcile)::int AS reconcile
     FROM topups WHERE status IN ('CREATED', 'AWAITING_APPROVAL')`,
  );
  const items = await pool.query<{ pending: number; unclaimed: number; oldestAt: Date | null }>(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE status = 'UNCLAIMED')::int AS unclaimed,
            min(created_at) AS "oldestAt"
     FROM payout_items WHERE status IN ('PENDING', 'UNCLAIMED')`,
  );
  const batches = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payout_batches WHERE needs_reconcile`,
  );

  const t = topups.rows[0]!;
  const i = items.rows[0]!;
  return {
    gate: gate.rows.map((r) => ({
      ...r,
      lastGateSeenAt: iso(r.lastGateSeenAt),
      lastHitAt: iso(r.lastHitAt),
    })),
    openTopups: { count: t.count, oldestAt: iso(t.oldestAt), needsReconcile: t.reconcile },
    pendingPayouts: {
      pendingItems: i.pending,
      unclaimedItems: i.unclaimed,
      oldestAt: iso(i.oldestAt),
      batchesNeedingReconcile: batches.rows[0]!.n,
    },
  };
}
