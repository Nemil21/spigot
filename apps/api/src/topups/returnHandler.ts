import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { captureTopup, type TopupDeps } from './capture.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

/**
 * `GET /topups/return?token=<orderId>` (api.md; features/08 §Manual top-up 6): where PayPal sends
 * the buyer after approving a wallet order outside W11 (an agent's approval link). Find the
 * top-up by its order id, capture (`capture:<topupId>`, idempotent) and credit, then 302 to the
 * W11 page. The cancel URL (`?cancelled=1`) leaves the top-up AWAITING_APPROVAL (SP-019 sweeps it).
 *
 * No session needed: the order id PayPal hands back is the capability, and capturing an order the
 * buyer just approved can only credit that buyer. An unknown token changes nothing.
 */
export const returnQuery = z.object({
  token: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  cancelled: z.string().optional(),
});

export type ReturnQuery = z.infer<typeof returnQuery>;

const W11 = '/buyers/topup';

export async function handleTopupReturn(deps: TopupDeps, query: unknown): Promise<string> {
  const parsed = returnQuery.safeParse(query);
  const token = parsed.success ? parsed.data.token : undefined;
  if (!token) return `${W11}?error=INVALID_RETURN`;

  const { rows } = await deps.db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups WHERE paypal_order_id = $1`,
    [token],
  );
  const topup = rows[0];
  if (!topup) return `${W11}?error=UNKNOWN_ORDER`;
  const page = `${W11}/${encodeURIComponent(topup.id)}`;
  if (parsed.data?.cancelled !== undefined) return `${page}?cancelled=1`;

  try {
    const outcome = await captureTopup(deps, topup, {
      actorType: 'BUYER',
      actorId: topup.buyerId,
    });
    return outcome.status === 'COMPLETED' ? `${page}?ok=1` : `${page}?pending=1`;
  } catch (err) {
    if (err instanceof ApiError) return `${page}?error=${encodeURIComponent(err.code)}`;
    throw err;
  }
}
