// Claims MCP tool (api.md §MCP server `report_bad_record`; features/10 §Claims 1–2; SP-048c).
// Calls the same service as `POST /v1/claims` (`submitClaim`): STALE / REMOVED re-fetch the page
// at once, MISSING_FIELD / DUPLICATE are checked from the served body, the rest wait for the
// site owner. Free.
import { z } from 'zod';
import { formatMicros } from '@spigot/shared';
import { CLAIM_REASONS } from '../../claims/checks.js';
import type { ClaimResult } from '../../claims/create.js';
import { claimDeps, submitClaim } from '../../claims/refetchCheck.js';
import { guard, ok } from '../results.js';
import { callerOf, type ToolModule } from '../tools.js';

const DESCRIPTION =
  'Report a record you paid for that is wrong: STALE (no longer true, e.g. the listing is already ' +
  'leased), REMOVED (the page is gone), MISSING_FIELD, DUPLICATE or WRONG_VALUE. Pass the callId ' +
  'from the search_records / get_changes result and the record key as served ' +
  '("listings/<key>"). Free. If Spigot can confirm it (STALE / REMOVED re-check the live page), ' +
  'the record’s price goes back to your balance at once; otherwise the site owner decides. ' +
  'Claims must be made within 7 days of the call; one claim per record per call.';

const claimOutput = {
  claimId: z.string(),
  status: z.enum(['OPEN', 'AUTO_CREDITED', 'CREDITED', 'REJECTED']),
  creditMicros: z.number(),
};

/** The agent-facing line for a claim. */
export function claimSummary(c: ClaimResult): string {
  switch (c.status) {
    case 'AUTO_CREDITED':
    case 'CREDITED':
      return `Claim confirmed: ${formatMicros(c.creditMicros)} credited back to your balance.`;
    case 'REJECTED':
      return 'This claim was reviewed and rejected by the site owner; nothing was credited.';
    default:
      return (
        'Claim recorded (open). Spigot could not confirm it automatically, so the site owner ' +
        'will review it; nothing is credited yet.'
      );
  }
}

const register: ToolModule = (server, deps) => {
  server.registerTool(
    'report_bad_record',
    {
      title: 'Report a bad record',
      description: DESCRIPTION,
      inputSchema: {
        callId: z.string().uuid().describe('The callId of the paid call that returned the record.'),
        recordKey: z
          .string()
          .min(1)
          .max(500)
          .describe('The record key as served, e.g. "listings/austin-2br-1042".'),
        reason: z.enum(CLAIM_REASONS).describe('What is wrong with the record.'),
        note: z.string().max(2000).optional().describe('Optional detail for the site owner.'),
      },
      outputSchema: claimOutput,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      guard(deps.log, 'report_bad_record', async () => {
        const caller = callerOf(extra);
        if (!deps.config) throw new Error('report_bad_record: ToolDeps.config is not set');
        const c = await submitClaim(claimDeps(deps.db, deps.config), {
          buyerId: caller.buyerId,
          callId: args.callId,
          recordKey: args.recordKey,
          reason: args.reason,
          note: args.note ?? null,
          actorType: 'MCP_CLIENT',
        });
        return ok(claimSummary(c), { ...c });
      }),
  );
};

export default register;
