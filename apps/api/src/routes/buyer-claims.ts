import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { createClaim } from '../claims/create.js';
import { parse } from '../http/errors.js';
import { claimRequestBody } from './v1-claims.js';

/**
 * Buyer claims in the portal (W12 "Report a bad record" and the claims list; features/10 §Claims;
 * SP-050), session cookie only:
 * - `POST /api/buyer/claims` `{ callId, recordKey, reason, note? }` → the same `createClaim` as
 *   `POST /v1/claims` (SP-048a): `{ claimId, status: 'AUTO_CREDITED' | 'OPEN' | …, creditMicros }`.
 *   A resend returns the existing claim; another buyer's call is 404; ineligible → 422.
 * - `GET /api/buyer/claims?limit=` → `{ claims }`, the signed-in buyer's own claims, newest first.
 *   No publisher identity and no AI recommendation: those are the publisher's (W08 claims tab).
 * Tenancy: `security/tenancy/buyer-claims.cases.ts`.
 */

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

interface BuyerClaimRow {
  id: string;
  status: 'OPEN' | 'AUTO_CREDITED' | 'CREDITED' | 'REJECTED';
  reason: string;
  note: string | null;
  callId: string;
  siteSlug: string;
  datasetSlug: string;
  recordKey: string;
  unitPriceMicros: number | null;
  creditMicros: number | null;
  decidedBy: 'AUTO' | 'PUBLISHER' | 'ADMIN' | null;
  createdAt: Date;
  updatedAt: Date;
}

const buyerClaimRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/buyer/claims', async (req) => {
    const buyer = requireBuyerSession(req);
    const body = parse(claimRequestBody, req.body ?? {}, 'claim');
    return createClaim(
      { db: app.db },
      {
        buyerId: buyer.id,
        callId: body.callId,
        recordKey: body.recordKey,
        reason: body.reason,
        note: body.note ?? null,
      },
    );
  });

  app.get('/api/buyer/claims', async (req) => {
    const buyer = requireBuyerSession(req);
    const query = parse(listQuery, req.query ?? {}, 'query');
    const { rows } = await app.db.pool.query<BuyerClaimRow>(
      `SELECT c.id, c.status, c.reason, c.note, c.api_call_id AS "callId",
              coalesce(s.slug, s.origin) AS "siteSlug", d.slug AS "datasetSlug",
              r.record_key AS "recordKey", a.unit_price_micros AS "unitPriceMicros",
              c.credit_micros AS "creditMicros", c.decided_by AS "decidedBy",
              c.created_at AS "createdAt", c.updated_at AS "updatedAt"
         FROM claims c
         JOIN records r ON r.id = c.record_id
         JOIN datasets d ON d.id = r.dataset_id
         JOIN sites s ON s.id = d.site_id
         JOIN api_calls a ON a.id = c.api_call_id
        WHERE c.buyer_id = $1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2`,
      [buyer.id, query.limit],
    );
    return {
      claims: rows.map((c) => ({
        id: c.id,
        status: c.status,
        reason: c.reason,
        note: c.note,
        callId: c.callId,
        site: c.siteSlug,
        dataset: c.datasetSlug,
        recordKey: `${c.datasetSlug}/${c.recordKey}`,
        /** What a credit gives back: the record's price on that call. */
        amountMicros: c.unitPriceMicros ?? 0,
        creditMicros: c.creditMicros ?? 0,
        decidedBy: c.decidedBy,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });
};

export default buyerClaimRoutes;
