import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  apiKeyRateLimit,
  authenticateBearer,
  requireApiKey,
  requireScope,
} from '../auth/apiKeys.js';
import { parse } from '../http/errors.js';
import { checkClientKey } from '../meter/idempotency.js';
import { agentTopUp } from '../services/agentTopUp.js';
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, topupPayPal } from '../topups/index.js';
import { idempotencyKeyHeader } from './v1.schemas.js';

/**
 * `POST /v1/topups` (api.md §`POST /v1/topups`; features/08 §MCP `top_up`; SP-022b): the REST twin
 * of MCP `top_up`, through the same `agentTopUp` service. Bearer API key with the `topup` scope
 * (else 403), the key's REST rate limit, optional `Idempotency-Key` (without it, a resend within
 * the same minute is the same top-up).
 *
 * P0 → `200 { topupId, status: 'AWAITING_APPROVAL', approveUrl, amountCents, orderId }`; the
 * human opens `approveUrl`, PayPal returns them to `/topups/return`, which captures and credits
 * once. A replay of a finished top-up returns its final status (`COMPLETED` adds
 * `balanceMicros`). With a saved method (SP-047b) → charged now within the monthly cap:
 * `{ status: 'COMPLETED', method: 'VAULT_MIT', balanceMicros }`; past the cap → 422
 * `AUTO_TOPUP_CAP_REACHED` (no PayPal call); declined → 422 `TOPUP_FAILED`.
 *
 * Its own file rather than `v1.ts` (hot-spot rule: add a file). Tenancy:
 * `security/tenancy/v1-topups.cases.ts`.
 */
export const topupRequestBody = z.object({
  amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
});

const v1TopupRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/topups',
    {
      onRequest: authenticateBearer,
      preHandler: [apiKeyRateLimit('rest'), requireScope('topup')],
    },
    async (req) => {
      const key = requireApiKey(req);
      const header = parse(
        idempotencyKeyHeader,
        req.headers['idempotency-key'],
        'Idempotency-Key header',
      );
      const body = parse(topupRequestBody, req.body ?? {}, 'top-up');
      return agentTopUp(
        { db: app.db, pp: topupPayPal(app.config), config: app.config },
        {
          buyerId: key.buyerId,
          apiKeyId: key.id,
          amountCents: body.amountCents,
          ...(header !== undefined ? { idempotencyKey: checkClientKey(header) } : {}),
        },
      );
    },
  );
};

export default v1TopupRoutes;
