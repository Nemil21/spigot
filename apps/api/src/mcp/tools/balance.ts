// Balance MCP tools (api.md §MCP server; features/11 §Logic 2; SP-022b): `get_balance` (free) and
// `top_up`. Each calls the same service as `/v1` (`GET /v1/balance`, `POST /v1/topups`).
import { z } from 'zod';
import { formatCents, formatMicros, topupStatusLabel, type TopupStatus } from '@spigot/shared';
import { balance, type BuyerBalance } from '../../services/balance.js';
import { agentTopUp, type AgentTopUpResult } from '../../services/agentTopUp.js';
import { topupPayPal } from '../../topups/index.js';
import { guard, ok, toolError } from '../results.js';
import { callerOf, idempotencyKeyFor, type Caller, type ToolModule } from '../tools.js';
import { idempotencyKeyInput } from '../inputs.js';

/**
 * P0 wording. SP-047b (vault charge within the cap) switches this to api.md's "Charges the saved
 * PayPal payment method of the account owner, up to their monthly cap."
 */
const TOP_UP_DESCRIPTION =
  'Asks the account owner to add money to your Spigot balance with PayPal. Returns a PayPal ' +
  'approval link (approveUrl): show it to your user; the balance is credited once they approve ' +
  'it in PayPal (check with get_balance). amountCents is $5–$500 in cents (2000 = $20). Nothing ' +
  'moves until they approve.';

const balanceOutput = {
  balanceMicros: z.number(),
  autoTopup: z.object({
    enabled: z.boolean(),
    thresholdMicros: z.number(),
    amountCents: z.number(),
    remainingThisMonthCents: z.number(),
    hasSavedMethod: z.boolean(),
  }),
};

/** "Balance $19.94. Auto top-up is on: $20 when below $2 ($80 left this month)." */
export function balanceSummary(b: BuyerBalance): string {
  const a = b.autoTopup;
  const auto = !a.enabled
    ? 'Auto top-up is off: ask your user to top up when the balance runs low (top_up).'
    : `Auto top-up is on: ${formatCents(a.amountCents)} when below ` +
      `${formatMicros(a.thresholdMicros)} (${formatCents(a.remainingThisMonthCents)} left this ` +
      `month).${a.hasSavedMethod ? '' : ' No PayPal method is saved yet, so it cannot run.'}`;
  return `Balance ${formatMicros(b.balanceMicros)}. ${auto}`;
}

/** The agent-facing line for a `top_up` result. */
export function topUpSummary(t: AgentTopUpResult): string {
  const amount = formatCents(t.amountCents);
  if (t.status === 'AWAITING_APPROVAL' || t.status === 'CREATED') {
    return t.approveUrl
      ? `Open this PayPal link to add ${amount} to your Spigot balance: ${t.approveUrl}\n` +
          'Show it to your user. The balance is credited once they approve in PayPal; call ' +
          'get_balance to check.'
      : `A ${amount} top-up is waiting for PayPal approval. Call top_up again for the link.`;
  }
  if (t.status === 'COMPLETED') {
    return (
      `This ${amount} top-up was already added via PayPal` +
      (t.balanceMicros !== undefined ? `; balance ${formatMicros(t.balanceMicros)}.` : '.')
    );
  }
  return (
    `This ${amount} top-up is closed (${topupStatusLabel(t.status as TopupStatus)}). Call ` +
    'top_up with a new idempotencyKey for a new link.'
  );
}

function requireTopup(caller: Caller) {
  if (!caller.scopes.includes('topup')) {
    return toolError(
      'FORBIDDEN',
      'This API key lacks the "topup" scope, so it cannot start a top-up. Ask your user to top ' +
        'up in the Spigot buyer portal, or to create a key with the "topup" scope.',
      { requiredScope: 'topup' },
    );
  }
  return null;
}

const register: ToolModule = (server, deps) => {
  server.registerTool(
    'get_balance',
    {
      title: 'Get balance',
      description:
        'Your prepaid Spigot balance and auto top-up status (on/off, threshold, amount, how much ' +
        'of the monthly cap is left). Free.',
      inputSchema: {},
      outputSchema: balanceOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      guard(deps.log, 'get_balance', async () => {
        const caller = callerOf(extra);
        const b = await balance({ db: deps.db.pool }, caller.buyerId);
        return ok(balanceSummary(b), { ...b });
      }),
  );

  server.registerTool(
    'top_up',
    {
      title: 'Top up the balance with PayPal',
      description: TOP_UP_DESCRIPTION,
      inputSchema: {
        amountCents: z
          .number()
          .int()
          .describe('Amount in US cents, 500–50000 ($5–$500). 2000 = $20.'),
        idempotencyKey: idempotencyKeyInput,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      guard(deps.log, 'top_up', async () => {
        const caller = callerOf(extra);
        const forbidden = requireTopup(caller);
        if (forbidden) return forbidden;
        if (!deps.config) throw new Error('top_up: ToolDeps.config is not set');
        const key = idempotencyKeyFor(caller, args.idempotencyKey);
        const t = await agentTopUp(
          { db: deps.db, pp: topupPayPal(deps.config), config: deps.config },
          {
            buyerId: caller.buyerId,
            apiKeyId: caller.apiKeyId,
            amountCents: args.amountCents,
            ...(key !== undefined ? { idempotencyKey: key } : {}),
            ...(deps.now ? { now: deps.now() } : {}),
          },
        );
        return ok(topUpSummary(t), { ...t });
      }),
  );
};

export default register;
