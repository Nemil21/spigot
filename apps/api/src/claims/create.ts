import { audit } from '../audit/audit.js';
import type { Db, Tx } from '../db/tx.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';
import {
  CLAIM_WINDOW_MS,
  parseServedKeys,
  runCheck,
  type ClaimReason,
  type VersionRow,
} from './checks.js';
import { creditClaim, lockBuyer } from './credit.js';

/**
 * `createClaim` (features/10 §Claims 1, 2, 4, 5; api.md §`POST /v1/claims`; SP-048a): a buyer
 * reports a junk record from one of their paid calls and gets that record's price back at once
 * when a deterministic check confirms it.
 *
 * Eligibility: the call is the buyer's own (else 404), was charged, is ≤ 7 days old, and the
 * record key is in its `served_record_keys` (else 422 `CLAIM_NOT_ELIGIBLE`). One claim per record
 * per call: a resend returns the existing claim. `MISSING_FIELD` / `DUPLICATE` are checked here;
 * confirmed and within the abuse limit → `AUTO_CREDITED` with a CREDIT posting. Everything else
 * stays `OPEN` for SP-048b (triage) and SP-048c (STALE / REMOVED re-fetch: callers go through
 * `submitClaim` in `refetchCheck.ts`, which runs it after this commits).
 *
 * One transaction, buyer row locked first (see `lockBuyer`), so parallel claims from one buyer
 * are serialized: the same claim 10× is one claim and one CREDIT, and 10 different claims stop
 * at the abuse limit.
 */

export interface ClaimInput {
  buyerId: string;
  callId: string;
  /** The public key as served (`<dataset>/<key>`). */
  recordKey: string;
  reason: ClaimReason;
  note?: string | null;
  /** `MCP_CLIENT` for SP-048c's `report_bad_record`. */
  actorType?: 'BUYER' | 'MCP_CLIENT';
}

export type ClaimStatus = 'OPEN' | 'AUTO_CREDITED' | 'CREDITED' | 'REJECTED';

export interface ClaimResult {
  claimId: string;
  status: ClaimStatus;
  creditMicros: number;
}

interface CallRow {
  id: string;
  status: string;
  createdAt: Date;
  servedRecordKeys: unknown;
  datasetId: string | null;
  datasetSlug: string | null;
  activeSchemaId: string | null;
  publisherId: string | null;
}

const notEligible = (message: string, details?: Record<string, unknown>) =>
  new ApiError('CLAIM_NOT_ELIGIBLE', message, details);

const CLAIMABLE_STATUSES = new Set(['CHARGED', 'PARTIALLY_CREDITED', 'CREDITED']);

export async function createClaim(
  deps: { db: Db; now?: () => Date },
  input: ClaimInput,
): Promise<ClaimResult> {
  return deps.db.tx(async (tx) => {
    if (!(await lockBuyer(tx, input.buyerId))) throw new ApiError('NOT_FOUND', 'Unknown buyer.');

    const call = await loadCall(tx, input.buyerId, input.callId);
    // Another buyer's call looks exactly like a missing one.
    if (!call) throw new ApiError('NOT_FOUND', 'No call with that id.');
    if (!CLAIMABLE_STATUSES.has(call.status)) {
      throw notEligible('That call was not charged, so there is nothing to claim.', {
        callStatus: call.status,
      });
    }
    const now = deps.now?.() ?? new Date();
    if (now.getTime() - call.createdAt.getTime() > CLAIM_WINDOW_MS) {
      throw notEligible('Claims must be made within 7 days of the call.');
    }
    const served = parseServedKeys(call.servedRecordKeys);
    const prefix = call.datasetSlug === null ? null : `${call.datasetSlug}/`;
    if (
      prefix === null ||
      !input.recordKey.startsWith(prefix) ||
      !served.some((s) => s.key === input.recordKey)
    ) {
      throw notEligible('That record was not in the call’s response.', {
        recordKey: input.recordKey,
      });
    }
    const record = await tx.query<{ id: string }>(
      `SELECT id FROM records WHERE dataset_id = $1 AND record_key = $2`,
      [call.datasetId, input.recordKey.slice(prefix.length)],
    );
    const recordId = record.rows[0]?.id;
    if (!recordId)
      throw notEligible('That record was not in the call’s response.', {
        recordKey: input.recordKey,
      });

    // One claim per record per call: a resend (or a racing duplicate, serialized by the buyer
    // lock) gets the claim that already exists.
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO claims (api_call_id, record_id, buyer_id, reason, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (api_call_id, record_id) DO NOTHING
       RETURNING id`,
      [call.id, recordId, input.buyerId, input.reason, input.note ?? null],
    );
    const claimId = inserted.rows[0]?.id;
    if (!claimId) return existingClaim(tx, call.id, recordId);

    const versions = await tx.query<VersionRow>(
      `SELECT version, op, patch, hash FROM record_versions WHERE record_id = $1 ORDER BY version`,
      [recordId],
    );
    const check = runCheck({
      reason: input.reason,
      key: input.recordKey,
      served,
      versions: versions.rows,
      storedFields: await schemaAtCall(tx, call),
    });
    if (!check.confirmed || !call.publisherId) return { claimId, status: 'OPEN', creditMicros: 0 };

    const credit = await creditClaim(tx, {
      claimId,
      callId: call.id,
      buyerId: input.buyerId,
      publisherId: call.publisherId,
    });
    if (!credit.credited) return { claimId, status: 'OPEN', creditMicros: 0 };

    await transition(tx, 'claims', claimId, 'OPEN', 'AUTO_CREDITED', {
      credit_micros: credit.creditMicros,
      decided_by: 'AUTO',
      ledger_txn_id: credit.ledgerTxnId,
    });
    await audit(tx, {
      actorType: input.actorType ?? 'BUYER',
      actorId: input.buyerId,
      publisherId: call.publisherId,
      entity: 'claims',
      entityId: claimId,
      action: 'CLAIM_DECIDED',
      data: {
        callId: call.id,
        reason: input.reason,
        status: 'AUTO_CREDITED',
        decidedBy: 'AUTO',
        creditMicros: credit.creditMicros,
        ledgerTxnId: credit.ledgerTxnId,
        callStatus: credit.callStatus,
        check: check.detail,
      },
    });
    return { claimId, status: 'AUTO_CREDITED', creditMicros: credit.creditMicros };
  });
}

async function loadCall(tx: Tx, buyerId: string, callId: string): Promise<CallRow | null> {
  const { rows } = await tx.query<CallRow>(
    `SELECT c.id, c.status, c.created_at AS "createdAt", c.served_record_keys AS "servedRecordKeys",
            c.dataset_id AS "datasetId", d.slug AS "datasetSlug",
            d.active_schema_id AS "activeSchemaId", s.publisher_id AS "publisherId"
       FROM api_calls c
       LEFT JOIN datasets d ON d.id = c.dataset_id
       LEFT JOIN sites s ON s.id = d.site_id
      WHERE c.id = $1 AND c.buyer_id = $2`,
    [callId, buyerId],
  );
  return rows[0] ?? null;
}

/**
 * The schema fields in force when the call was served (`api_calls` has no schema snapshot): the
 * newest version approved at or before the call. Falls back to the active schema only when it
 * wasn't approved after the call (e.g. seeded rows with no `approved_at`). Otherwise `null`: the
 * required set is unknown, so `MISSING_FIELD` stays OPEN rather than charging the publisher for a
 * field that may not have been required when served.
 */
export async function schemaAtCall(
  tx: Tx,
  call: Pick<CallRow, 'datasetId' | 'createdAt' | 'activeSchemaId'>,
): Promise<unknown> {
  const { rows } = await tx.query<{ fields: unknown }>(
    `(SELECT fields, 0 AS pick FROM schema_versions
       WHERE dataset_id = $1 AND status IN ('APPROVED', 'SUPERSEDED') AND approved_at <= $2
       ORDER BY approved_at DESC, version DESC LIMIT 1)
     UNION ALL
     (SELECT fields, 1 AS pick FROM schema_versions
       WHERE id = $3 AND (approved_at IS NULL OR approved_at <= $2))
     ORDER BY pick LIMIT 1`,
    [call.datasetId, call.createdAt, call.activeSchemaId],
  );
  return rows[0]?.fields ?? null;
}

async function existingClaim(tx: Tx, callId: string, recordId: string): Promise<ClaimResult> {
  const { rows } = await tx.query<{ id: string; status: ClaimStatus; credit: number | null }>(
    `SELECT id, status, credit_micros AS credit FROM claims WHERE api_call_id = $1 AND record_id = $2`,
    [callId, recordId],
  );
  const row = rows[0]!;
  return { claimId: row.id, status: row.status, creditMicros: row.credit ?? 0 };
}
