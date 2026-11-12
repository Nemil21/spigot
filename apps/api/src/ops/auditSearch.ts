import type pg from 'pg';
import { z } from 'zod';
import { AUDIT_ACTIONS } from '../audit/actions.js';

/**
 * `GET /admin/audit` (api.md §Ops; SP-043): find audit rows by publisher, entity, PayPal id
 * (order / capture / refund / payout id), actor (W14's buyer search) or action, within
 * `[from, to)`. Newest first, keyset-paged on `id` (`cursor` = the last row's id, from `next`).
 */
export const auditSearchQuery = z
  .object({
    publisherId: z.uuid().optional(),
    entity: z.string().trim().min(1).max(64).optional(),
    paypalId: z.string().trim().min(1).max(128).optional(),
    actorId: z.string().trim().min(1).max(128).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,17}$/, 'Invalid cursor.')
      .optional(),
  })
  .strict();

export type AuditSearchQuery = z.infer<typeof auditSearchQuery>;

export interface AuditRow {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  publisherId: string | null;
  entity: string | null;
  entityId: string | null;
  action: string;
  paypalId: string | null;
  data: unknown;
}

export interface AuditPage {
  events: AuditRow[];
  /** Pass as `cursor` for the next page; `null` on the last page. */
  next: string | null;
}

export async function searchAudit(pool: pg.Pool, q: AuditSearchQuery): Promise<AuditPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.publisherId) add('publisher_id = ?', q.publisherId);
  if (q.entity) add('entity = ?', q.entity);
  if (q.paypalId) add('paypal_id = ?', q.paypalId);
  if (q.actorId) add('actor_id = ?', q.actorId);
  if (q.action) add('action = ?', q.action);
  if (q.from) add('at >= ?', q.from);
  if (q.to) add('at < ?', q.to);
  if (q.cursor) add('id < ?', q.cursor);
  params.push(q.limit + 1);

  const { rows } = await pool.query<AuditRow & { at: Date }>(
    `SELECT id::text AS id, at, actor_type AS "actorType", actor_id AS "actorId",
            publisher_id AS "publisherId", entity, entity_id AS "entityId", action,
            paypal_id AS "paypalId", data
     FROM audit_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY audit_events.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    events: page.map((r) => ({ ...r, at: r.at.toISOString() })),
    next: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}
