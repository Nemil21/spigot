import type { Queryable } from '../db/index.js';
import { isAuditAction, type ActorType, type AuditAction } from './actions.js';

export {
  AUDIT_ACTIONS,
  ACTOR_TYPES,
  isAuditAction,
  type ActorType,
  type AuditAction,
} from './actions.js';

export interface AuditEvent {
  actorType: ActorType;
  /** publishers.id, buyers.id, an API key id, a workflow run id, … (text). */
  actorId?: string | null;
  /** The publisher the row concerns, for the publisher's activity and admin search. */
  publisherId?: string | null;
  /** Table name of the subject, e.g. `sites`, `topups`, `payout_items`. */
  entity?: string | null;
  entityId?: string | null;
  action: AuditAction;
  /** Order / capture / refund / payout batch or item id. Required by convention on money rows. */
  paypalId?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Append one `audit_events` row (features/14 §Audit and ops). Pass the transaction that makes
 * the change, so the row commits or rolls back with it. Rows are append-only: SP-002's
 * `forbid_mutation` trigger refuses UPDATE / DELETE / TRUNCATE, even for the table owner.
 * Returns the row id.
 */
export async function audit(tx: Queryable, e: AuditEvent): Promise<number> {
  // The type already restricts `action`; this guards casts and untyped callers.
  if (!isAuditAction(e.action)) throw new TypeError(`Unknown audit action: ${String(e.action)}`);
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO audit_events (actor_type, actor_id, publisher_id, entity, entity_id, action, paypal_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      e.actorType,
      e.actorId ?? null,
      e.publisherId ?? null,
      e.entity ?? null,
      e.entityId ?? null,
      e.action,
      e.paypalId ?? null,
      e.data == null ? null : JSON.stringify(e.data),
    ],
  );
  return rows[0]!.id;
}
