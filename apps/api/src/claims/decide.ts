import { audit } from '../audit/audit.js';
import type { Db } from '../db/tx.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';
import { creditClaim, lockBuyer } from './credit.js';
import type { ClaimStatus } from './create.js';

/**
 * The publisher decides an OPEN claim (features/10 §Claims 3–4; api.md §`POST /api/claims/:id/decide`;
 * data-model §Claim `OPEN → CREDITED | REJECTED`; SP-048b). The AI recommendation is advice
 * only: this is the one place a triaged claim moves money, and only on a human's click.
 *
 * - `CREDIT` → SP-048a's `creditClaim` (the record's `unit_price_micros`, ledger CREDIT
 *   `claim:<id>`, call → PARTIALLY_CREDITED / CREDITED), claim → CREDITED. The 10% abuse limit
 *   does not apply: it caps automatic credits, and the publisher is the one paying.
 * - `REJECT` → claim → REJECTED. No money.
 *
 * Tenancy: the claim's record must be in a dataset of a site the publisher owns; anyone else's
 * claim is 404, like a missing one. Idempotent and race-safe: the buyer row is locked first (same
 * lock order as `createClaim`), then the claim `FOR UPDATE`; a repeat of the same decision returns
 * the stored result, a different decision on a decided claim is 409 `STATE_CONFLICT`, and the
 * CREDIT posting's idempotency key makes a second credit impossible anyway.
 */

export type Decision = 'CREDIT' | 'REJECT';

export interface DecideInput {
  publisherId: string;
  claimId: string;
  decision: Decision;
}

export interface DecideResult {
  claimId: string;
  status: ClaimStatus;
  creditMicros: number;
  /** True when the claim was already decided this way (nothing was done now). */
  replay: boolean;
}

const DECIDED: Record<Decision, ClaimStatus> = { CREDIT: 'CREDITED', REJECT: 'REJECTED' };

export async function decideClaim(deps: { db: Db }, input: DecideInput): Promise<DecideResult> {
  return deps.db.tx(async (tx) => {
    const owned = await tx.query<{ buyerId: string; publisherId: string }>(
      `SELECT c.buyer_id AS "buyerId", s.publisher_id AS "publisherId"
         FROM claims c
         JOIN records r ON r.id = c.record_id
         JOIN datasets d ON d.id = r.dataset_id
         JOIN sites s ON s.id = d.site_id
        WHERE c.id = $1 AND s.publisher_id = $2`,
      [input.claimId, input.publisherId],
    );
    const own = owned.rows[0];
    if (!own) throw new ApiError('NOT_FOUND', 'No claim with that id.');

    await lockBuyer(tx, own.buyerId);
    const { rows } = await tx.query<{
      status: ClaimStatus;
      creditMicros: number | null;
      callId: string;
      reason: string;
      ai: { status?: string; decision?: string; confidence?: number } | null;
    }>(
      `SELECT status, credit_micros AS "creditMicros", api_call_id AS "callId", reason,
              ai_recommendation AS ai
         FROM claims WHERE id = $1 FOR UPDATE`,
      [input.claimId],
    );
    const claim = rows[0]!;

    if (claim.status !== 'OPEN') {
      // CREDIT on an AUTO_CREDITED claim: the buyer already has the money back; same answer.
      const same =
        claim.status === DECIDED[input.decision] ||
        (input.decision === 'CREDIT' && claim.status === 'AUTO_CREDITED');
      if (!same) {
        throw new ApiError(
          'STATE_CONFLICT',
          `This claim was already ${claim.status.toLowerCase()}.`,
          {
            status: claim.status,
          },
        );
      }
      return {
        claimId: input.claimId,
        status: claim.status,
        creditMicros: claim.creditMicros ?? 0,
        replay: true,
      };
    }

    let creditMicros = 0;
    let ledgerTxnId: string | null = null;
    let callStatus: string | null = null;
    if (input.decision === 'CREDIT') {
      const credit = await creditClaim(tx, {
        claimId: input.claimId,
        callId: claim.callId,
        buyerId: own.buyerId,
        publisherId: own.publisherId,
        enforceAbuseLimit: false,
      });
      if (!credit.credited) {
        // The call is already fully credited by other claims (or was never priced): nothing
        // left to give back. The claim stays OPEN; the publisher can reject it.
        throw new ApiError(
          'STATE_CONFLICT',
          'Nothing left to credit on that call: it has already been credited in full.',
          { why: credit.why },
        );
      }
      creditMicros = credit.creditMicros;
      ledgerTxnId = credit.ledgerTxnId;
      callStatus = credit.callStatus;
    }

    const to = DECIDED[input.decision];
    await transition(tx, 'claims', input.claimId, 'OPEN', to, {
      decided_by: 'PUBLISHER',
      ...(input.decision === 'CREDIT'
        ? { credit_micros: creditMicros, ledger_txn_id: ledgerTxnId }
        : {}),
    });
    const ai = claim.ai?.status === 'READY' ? claim.ai : null;
    await audit(tx, {
      actorType: 'PUBLISHER',
      actorId: input.publisherId,
      publisherId: input.publisherId,
      entity: 'claims',
      entityId: input.claimId,
      action: 'CLAIM_DECIDED',
      data: {
        callId: claim.callId,
        reason: claim.reason,
        status: to,
        decidedBy: 'PUBLISHER',
        creditMicros,
        ledgerTxnId,
        callStatus,
        aiRecommendation: ai ? { decision: ai.decision, confidence: ai.confidence } : null,
        followedAi: ai ? DECIDED[ai.decision as Decision] === to : null,
      },
    });
    return { claimId: input.claimId, status: to, creditMicros, replay: false };
  });
}
