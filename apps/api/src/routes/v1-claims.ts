import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { apiKeyRateLimit, authenticateBearer, requireApiKey } from '../auth/apiKeys.js';
import { CLAIM_REASONS } from '../claims/checks.js';
import { createClaim } from '../claims/create.js';
import { parse } from '../http/errors.js';

/**
 * `POST /v1/claims` (api.md §`POST /v1/claims`; features/10 §Claims; SP-048a):
 * `{ callId, recordKey, reason, note? }` → `{ claimId, status: 'AUTO_CREDITED' | 'OPEN', creditMicros }`.
 * Bearer API key (any scope: claiming is free and only ever credits the key's own buyer), the
 * key's REST rate limit. Another buyer's call is `404`; an ineligible claim is
 * `422 CLAIM_NOT_ELIGIBLE`; a resend returns the existing claim.
 *
 * Its own file rather than `v1.ts` (hot-spot rule: add a file). Tenancy:
 * `security/tenancy/claims.cases.ts`.
 */
export const claimRequestBody = z.object({
  callId: z.string().uuid(),
  recordKey: z.string().min(1).max(500),
  reason: z.enum(CLAIM_REASONS),
  note: z.string().max(2000).nullish(),
});

export const claimResponse = z.object({
  claimId: z.string().uuid(),
  status: z.enum(['OPEN', 'AUTO_CREDITED', 'CREDITED', 'REJECTED']),
  creditMicros: z.int(),
});

const v1ClaimRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/claims',
    { onRequest: authenticateBearer, preHandler: [apiKeyRateLimit('rest')] },
    async (req) => {
      const key = requireApiKey(req);
      const body = parse(claimRequestBody, req.body ?? {}, 'claim');
      return createClaim(
        { db: app.db },
        {
          buyerId: key.buyerId,
          callId: body.callId,
          recordKey: body.recordKey,
          reason: body.reason,
          note: body.note ?? null,
        },
      );
    },
  );
};

export default v1ClaimRoutes;
