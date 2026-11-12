import { microsToCentsFloor } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';

/**
 * `GET /api/publishers/me/payouts` (api.md; W09): the caller's payout batches with **only their
 * own items** (another publisher's amounts or emails never leave the server), and the
 * next-payout card (payable, threshold, next Monday).
 */

export interface PayoutItemDto {
  id: string;
  paypalItemId: string | null;
  status: string;
  netCents: number;
  feeCents: number | null;
  grossMicros: number;
  commissionMicros: number;
  receiverEmail: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface PayoutBatchDto {
  id: string;
  paypalBatchId: string | null;
  status: string;
  trigger: string;
  needsReconcile: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  items: PayoutItemDto[];
}

export interface NextPayoutDto {
  payableMicros: number;
  /** `floor(payable / 10,000)`: what a run would send now. */
  payableCents: number;
  thresholdCents: number;
  /** Next scheduled run: Monday 09:00 PT (features/09 §Logic 9), as `YYYY-MM-DD`. */
  nextPayoutDate: string;
  /** In flight (PENDING / UNCLAIMED items): the next run skips this publisher until it resolves. */
  inFlightCents: number;
  /** Whether a run now would include this publisher. */
  eligible: boolean;
}

export interface PublisherPayoutsDto {
  isDemo: boolean;
  next: NextPayoutDto;
  batches: PayoutBatchDto[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The date (PT) of the next Monday 09:00 PT run at or after `now`. */
export function nextPayoutDate(now: Date): string {
  const parts = Object.fromEntries(PT.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = WEEKDAYS.indexOf(parts.weekday!);
  const hour = Number(parts.hour);
  let days = (1 - weekday + 7) % 7;
  if (days === 0 && hour >= 9) days = 7;
  // Calendar arithmetic on the PT date at UTC noon: no DST edge can move it a day.
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function publisherPayouts(
  q: Queryable,
  publisherId: string,
  now: Date = new Date(),
): Promise<PublisherPayoutsDto | null> {
  const pub = (
    await q.query<{ isDemo: boolean; thresholdCents: number; payableMicros: number }>(
      `SELECT p.is_demo AS "isDemo", p.payout_threshold_cents AS "thresholdCents",
              coalesce(a.balance_micros, 0)::bigint AS "payableMicros"
       FROM publishers p
       LEFT JOIN ledger_accounts a ON a.kind = 'PUBLISHER_PAYABLE' AND a.owner_id = p.id
       WHERE p.id = $1`,
      [publisherId],
    )
  ).rows[0];
  if (!pub) return null;
  const payableMicros = Number(pub.payableMicros);

  const { rows } = await q.query<{
    batchId: string;
    paypalBatchId: string | null;
    batchStatus: string;
    trigger: string;
    needsReconcile: boolean;
    periodStart: Date | null;
    periodEnd: Date | null;
    batchCreatedAt: Date;
    id: string;
    paypalItemId: string | null;
    status: string;
    netCents: number;
    feeCents: number | null;
    grossMicros: string | number | null;
    commissionMicros: string | number | null;
    receiverEmail: string | null;
    errorCode: string | null;
    updatedAt: Date;
  }>(
    `SELECT b.id AS "batchId", b.paypal_batch_id AS "paypalBatchId", b.status AS "batchStatus",
            b.trigger, b.needs_reconcile AS "needsReconcile", b.period_start AS "periodStart",
            b.period_end AS "periodEnd", b.created_at AS "batchCreatedAt",
            i.id, i.paypal_item_id AS "paypalItemId", i.status, i.net_cents AS "netCents",
            i.fee_cents AS "feeCents", i.gross_micros AS "grossMicros",
            i.commission_micros AS "commissionMicros", i.receiver_email AS "receiverEmail",
            i.error_code AS "errorCode", i.updated_at AS "updatedAt"
     FROM payout_items i JOIN payout_batches b ON b.id = i.batch_id
     WHERE i.publisher_id = $1
     ORDER BY b.created_at DESC, b.id, i.created_at, i.id
     LIMIT 500`,
    [publisherId],
  );

  const batches: PayoutBatchDto[] = [];
  const byId = new Map<string, PayoutBatchDto>();
  let inFlightCents = 0;
  for (const r of rows) {
    let b = byId.get(r.batchId);
    if (!b) {
      b = {
        id: r.batchId,
        paypalBatchId: r.paypalBatchId,
        status: r.batchStatus,
        trigger: r.trigger,
        needsReconcile: r.needsReconcile,
        periodStart: iso(r.periodStart),
        periodEnd: iso(r.periodEnd),
        createdAt: r.batchCreatedAt.toISOString(),
        items: [],
      };
      byId.set(r.batchId, b);
      batches.push(b);
    }
    if (r.status === 'PENDING' || r.status === 'UNCLAIMED') inFlightCents += r.netCents;
    b.items.push({
      id: r.id,
      paypalItemId: r.paypalItemId,
      status: r.status,
      netCents: r.netCents,
      feeCents: r.feeCents,
      grossMicros: Number(r.grossMicros ?? 0),
      commissionMicros: Number(r.commissionMicros ?? 0),
      receiverEmail: r.receiverEmail,
      errorCode: r.errorCode,
      updatedAt: r.updatedAt.toISOString(),
    });
  }

  const payableCents = Math.max(0, microsToCentsFloor(payableMicros));
  return {
    isDemo: pub.isDemo,
    next: {
      payableMicros,
      payableCents,
      thresholdCents: pub.thresholdCents,
      nextPayoutDate: nextPayoutDate(now),
      inFlightCents,
      eligible: inFlightCents === 0 && payableCents > 0 && payableCents >= pub.thresholdCents,
    },
    batches,
  };
}
