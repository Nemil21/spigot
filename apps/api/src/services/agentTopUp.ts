// `POST /v1/topups` and MCP `top_up` (api.md §`POST /v1/topups`; features/08 §MCP `top_up`;
// SP-022b). Both call this, so idempotency and the response are identical on either channel.
//
// P0: there is no vault charge yet, so every call goes to SP-018b's `createTopupForAgent`: a
// CAPTURE-intent wallet order (`trigger=MCP`) whose approval link the agent hands to its human.
// PayPal sends them back to `/topups/return`, which captures and credits once. SP-047b adds the
// vaulted charge within the monthly cap in front of this.
import { autoKey, requestHash } from '../meter/idempotency.js';
import { createTopupForAgent, type TopupDeps } from '../topups/index.js';
import { balance } from './balance.js';

export interface AgentTopUpInput {
  buyerId: string;
  apiKeyId: string;
  amountCents: number;
  /**
   * The client's key (REST `Idempotency-Key`, MCP `idempotencyKey`, or MCP's
   * `mcp:<session>:<jsonrpc id>`). Undefined → `autoKey` over the amount and a minute bucket, so
   * an accidental double-send is one top-up while a deliberate one a minute later is a new one.
   */
  idempotencyKey?: string;
  now?: Date;
}

export interface AgentTopUpResult {
  topupId: string;
  /** `AWAITING_APPROVAL` for a link; a replay of a finished top-up returns its final status. */
  status: string;
  amountCents: number;
  orderId: string | null;
  /** The PayPal approval link for the human; `null` once the top-up has finished. */
  approveUrl: string | null;
  /** Set when the top-up has `COMPLETED` (a replay after approval): the balance now. */
  balanceMicros?: number;
}

export async function agentTopUp(
  deps: TopupDeps,
  input: AgentTopUpInput,
): Promise<AgentTopUpResult> {
  const key =
    input.idempotencyKey ??
    autoKey(
      input.apiKeyId,
      requestHash({ op: 'topup', amountCents: input.amountCents }),
      input.now,
    );
  const t = await createTopupForAgent(deps, input.buyerId, input.amountCents, key);
  const out: AgentTopUpResult = {
    topupId: t.topupId,
    status: t.status,
    amountCents: t.amountCents,
    orderId: t.orderId,
    approveUrl: t.approveUrl,
  };
  if (t.status === 'COMPLETED') {
    out.balanceMicros = (await balance({ db: deps.db.pool }, input.buyerId)).balanceMicros;
  }
  return out;
}
