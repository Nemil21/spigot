import type pg from 'pg';
import { audit, type ActorType } from '../audit/audit.js';
import type { Db } from '../db/index.js';
import { ledgerCheck, type LedgerCheckResult } from '../ledger/check.js';

/**
 * Recorded ledger checks (features/07 §Ledger check; SP-061). The nightly job and
 * `POST /admin/ledger/check` both run `ledgerCheck()` through `recordLedgerCheck`, which appends
 * one `LEDGER_CHECKED` audit row per run and, on any mismatch, an `ALERT` row
 * (`data.kind = 'LEDGER_MISMATCH'`). `GET /admin/health` reads the latest `LEDGER_CHECKED` row:
 * a mismatch keeps health `degraded` until a later check comes back clean.
 */

export type LedgerCheckTrigger = 'NIGHTLY' | 'MANUAL';

/** `audit_events.entity` for check rows (indexed with `entity_id`, so the latest is cheap). */
export const LEDGER_CHECK_ENTITY = 'ledger_check';
export const LEDGER_MISMATCH_ALERT = 'LEDGER_MISMATCH';
/** Mismatches copied into the ALERT row; the rest are counted. */
const ALERT_DETAIL_MAX = 20;

export interface LedgerCheckBy {
  trigger: LedgerCheckTrigger;
  actorType: ActorType;
  actorId?: string | null;
}

export async function recordLedgerCheck(db: Db, by: LedgerCheckBy): Promise<LedgerCheckResult> {
  const result = await ledgerCheck(db.pool);
  const n = result.mismatches.length;
  await db.tx(async (tx) => {
    const common = {
      actorType: by.actorType,
      actorId: by.actorId ?? null,
      entity: LEDGER_CHECK_ENTITY,
    } as const;
    await audit(tx, {
      ...common,
      action: 'LEDGER_CHECKED',
      data: {
        trigger: by.trigger,
        ok: n === 0,
        mismatches: n,
        sumMicros: result.sumMicros,
        accountsChecked: result.accountsChecked,
      },
    });
    if (n > 0) {
      await audit(tx, {
        ...common,
        action: 'ALERT',
        data: {
          kind: LEDGER_MISMATCH_ALERT,
          trigger: by.trigger,
          mismatches: n,
          sumMicros: result.sumMicros,
          detail: result.mismatches.slice(0, ALERT_DETAIL_MAX),
        },
      });
    }
  });
  return result;
}

export interface LastLedgerCheck {
  at: Date;
  trigger: LedgerCheckTrigger;
  mismatches: number;
}

/** The latest recorded check, or `null` if none has run yet. */
export async function lastLedgerCheck(pool: pg.Pool): Promise<LastLedgerCheck | null> {
  const { rows } = await pool.query<{
    at: Date;
    data: { trigger: LedgerCheckTrigger; mismatches: number };
  }>(
    `SELECT at, data FROM audit_events
      WHERE entity = $1 AND action = 'LEDGER_CHECKED'
      ORDER BY id DESC LIMIT 1`,
    [LEDGER_CHECK_ENTITY],
  );
  const r = rows[0];
  return r ? { at: r.at, trigger: r.data.trigger, mismatches: Number(r.data.mismatches) } : null;
}
