import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePublisher } from '../auth/publisherAuth.js';
import { decideClaim } from '../claims/decide.js';
import { ApiError, parse } from '../http/errors.js';

/**
 * Publisher claims (api.md §`GET /api/claims?status=OPEN` · `POST /api/claims/:id/decide`;
 * features/10 §Claims 3; SP-048b), session auth:
 * - `GET /api/claims?status=OPEN&limit=` → `{ claims }`: claims on the caller's own sites'
 *   records, newest first, each with the triage agent's recommendation (`aiRecommendation`, null
 *   until triaged) and the amount a credit would give back.
 * - `POST /api/claims/:id/decide` `{ decision: 'CREDIT' | 'REJECT' }` → `{ claimId, status,
 *   creditMicros, replay }` (`claims/decide.ts`). Another publisher's claim is 404, checked
 *   before the body so a foreign id never learns anything; a conflicting second decision is 409.
 * No buyer identity is returned: the publisher sees the claim, not who made it.
 * Tenancy: `security/tenancy/publisher-claims.cases.ts`.
 */
export const CLAIM_STATUSES = ['OPEN', 'AUTO_CREDITED', 'CREDITED', 'REJECTED'] as const;

export const listClaimsQuery = z.object({
  status: z.enum(CLAIM_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const decideBody = z.object({ decision: z.enum(['CREDIT', 'REJECT']) });

const idParam = z.object({ id: z.string().uuid() });

interface ClaimListRow {
  id: string;
  status: (typeof CLAIM_STATUSES)[number];
  reason: string;
  note: string | null;
  datasetSlug: string;
  recordKey: string;
  datasetId: string;
  siteId: string;
  siteSlug: string;
  callId: string;
  unitPriceMicros: number | null;
  creditMicros: number | null;
  decidedBy: string | null;
  ai: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The stored recommendation as the dashboard shows it (failed tries collapse to a status). */
function aiView(ai: Record<string, unknown> | null) {
  if (!ai) return null;
  if (ai.status !== 'READY') return { status: ai.status, attempts: ai.attempts ?? null };
  return {
    status: 'READY',
    decision: ai.decision,
    confidence: ai.confidence,
    reason: ai.reason,
    model: ai.model,
    replayed: ai.replayed,
    at: ai.at,
  };
}

const publisherClaimRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/claims', async (req) => {
    const me = requirePublisher(req);
    const query = parse(listClaimsQuery, req.query ?? {}, 'query');
    const { rows } = await app.db.pool.query<ClaimListRow>(
      `SELECT c.id, c.status, c.reason, c.note, d.slug AS "datasetSlug", r.record_key AS "recordKey",
              d.id AS "datasetId", s.id AS "siteId", s.slug AS "siteSlug", c.api_call_id AS "callId",
              a.unit_price_micros AS "unitPriceMicros", c.credit_micros AS "creditMicros",
              c.decided_by AS "decidedBy", c.ai_recommendation AS ai,
              c.created_at AS "createdAt", c.updated_at AS "updatedAt"
         FROM claims c
         JOIN records r ON r.id = c.record_id
         JOIN datasets d ON d.id = r.dataset_id
         JOIN sites s ON s.id = d.site_id
         JOIN api_calls a ON a.id = c.api_call_id
        WHERE s.publisher_id = $1 AND ($2::text IS NULL OR c.status = $2)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $3`,
      [me.id, query.status ?? null, query.limit],
    );
    return {
      claims: rows.map((c) => ({
        id: c.id,
        status: c.status,
        reason: c.reason,
        note: c.note,
        site: { id: c.siteId, slug: c.siteSlug },
        dataset: { id: c.datasetId, slug: c.datasetSlug },
        recordKey: `${c.datasetSlug}/${c.recordKey}`,
        callId: c.callId,
        /** What a CREDIT gives back (the record's price on that call). */
        amountMicros: c.unitPriceMicros ?? 0,
        creditMicros: c.creditMicros,
        decidedBy: c.decidedBy,
        aiRecommendation: aiView(c.ai),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });

  app.post('/api/claims/:id/decide', async (req) => {
    const me = requirePublisher(req);
    const params = idParam.safeParse(req.params);
    if (!params.success) throw new ApiError('NOT_FOUND', 'No claim with that id.');
    // Ownership before the body: another publisher's claim id is a 404 whatever is sent.
    const owned = await app.db.pool.query(
      `SELECT 1 FROM claims c
         JOIN records r ON r.id = c.record_id
         JOIN datasets d ON d.id = r.dataset_id
         JOIN sites s ON s.id = d.site_id
        WHERE c.id = $1 AND s.publisher_id = $2`,
      [params.data.id, me.id],
    );
    if (owned.rowCount === 0) throw new ApiError('NOT_FOUND', 'No claim with that id.');
    const body = parse(decideBody, req.body ?? {}, 'decision');
    return decideClaim(
      { db: app.db },
      { publisherId: me.id, claimId: params.data.id, decision: body.decision },
    );
  });
};

export default publisherClaimRoutes;
