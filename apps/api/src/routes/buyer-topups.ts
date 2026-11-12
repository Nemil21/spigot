import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { ApiError, parse } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';
import { checkClientKey } from '../meter/idempotency.js';
import { isUuid } from '../tenancy.js';
import {
  captureTopup,
  createTopup,
  createTopupBody,
  handleTopupReturn,
  TOPUP_COLUMNS,
  topupPayPal,
  topupView,
  type TopupDeps,
  type TopupRow,
} from '../topups/index.js';

/**
 * Buyer top-ups (api.md §Buyer portal endpoints; features/08 §Manual top-up; SP-018a):
 * - `POST /api/buyer/topups` (Idempotency-Key required) → `201 { topupId, status, orderId, approveUrl }`
 *   `method: 'CARD'` (SP-063) answers the same `AWAITING_APPROVAL` + `orderId`: W11's card fields
 *   `submit(orderId)`, then call capture (which credits and vaults the card)
 * - `POST /api/buyer/topups/:id/capture` → `{ topupId, status: 'COMPLETED', balanceMicros, captureId }`
 *   (capture `PENDING` → `{ status: 'AWAITING_APPROVAL', pendingReason }`, no credit)
 * - `GET /api/buyer/topups` → the buyer's top-ups, newest first
 * - `GET /topups/return?token=` → capture → 302 `/buyers/topup/:id?ok=1`
 * Another buyer's top-up is a 404 (tenancy: `security/tenancy/topups.cases.ts`).
 */
const byIp = rateLimit('portal', (req) => `topups-return:${req.ip}`);

const notFound = () => new ApiError('NOT_FOUND', 'No such top-up.');

const buyerTopupRoutes: FastifyPluginAsync = async (app) => {
  const deps = (): TopupDeps => ({ db: app.db, pp: topupPayPal(app.config), config: app.config });

  /** The signed-in buyer's top-up `:id`, or 404 (never confirms another buyer's ids). */
  async function ownTopup(req: FastifyRequest, buyerId: string): Promise<TopupRow> {
    const { id } = req.params as { id?: string };
    if (!isUuid(id)) throw notFound();
    const { rows } = await app.db.pool.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1 AND buyer_id = $2`,
      [id, buyerId],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  app.post('/api/buyer/topups', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    const header = req.headers['idempotency-key'];
    if (typeof header !== 'string' || header === '') {
      throw new ApiError('VALIDATION_ERROR', 'The Idempotency-Key header is required.');
    }
    const idempotencyKey = checkClientKey(header);
    const body = parse(createTopupBody, req.body, 'top-up');
    const created = await createTopup(deps(), { ...body, buyerId: buyer.id, idempotencyKey });
    const t = created.topup;
    return reply.code(201).send({
      topupId: t.id,
      status: t.status,
      orderId: t.paypalOrderId,
      approveUrl: created.approveUrl,
      amountCents: t.amountCents,
      vaultRequested: created.vaultRequested,
      ...(created.capture?.status === 'COMPLETED'
        ? { balanceMicros: created.capture.balanceMicros, captureId: created.capture.captureId }
        : {}),
    });
  });

  app.post('/api/buyer/topups/:id/capture', async (req) => {
    const buyer = requireBuyerSession(req);
    const topup = await ownTopup(req, buyer.id);
    const outcome = await captureTopup(deps(), topup, { actorType: 'BUYER', actorId: buyer.id });
    if (outcome.status === 'PENDING') {
      return {
        topupId: topup.id,
        status: outcome.topup.status,
        pendingReason: outcome.pendingReason,
      };
    }
    return {
      topupId: topup.id,
      status: 'COMPLETED',
      balanceMicros: outcome.balanceMicros,
      captureId: outcome.captureId,
    };
  });

  app.get('/api/buyer/topups', async (req) => {
    const buyer = requireBuyerSession(req);
    const { rows } = await app.db.pool.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE buyer_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 100`,
      [buyer.id],
    );
    return { topups: rows.map(topupView) };
  });

  app.get('/topups/return', { preHandler: byIp }, async (req, reply) => {
    return reply.redirect(await handleTopupReturn(deps(), req.query), 302);
  });
};

export default buyerTopupRoutes;
