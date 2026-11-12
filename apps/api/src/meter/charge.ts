import { createHash } from 'node:crypto';
import { errorEnvelope, PUBLISHER_EVENTS_CHANNEL, publisherEvent } from '@spigot/shared';
import { notify } from '../db/notify.js';
import { transition } from '../db/transition.js';
import type { Db, Tx } from '../db/tx.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { InsufficientBalance } from '../ledger/errors.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries } from '../ledger/postings.js';
import { autoKey, checkClientKey, claimCall, requestHash, type StoredCall } from './idempotency.js';
import { priceMicros } from './quote.js';

/**
 * `chargeAndRecord` (features/07, data-model rules 3–4): the metering transaction. The caller
 * has already built the full response (records filtered, hidden fields stripped); this charges
 * for it and stores it in one transaction, so a buyer is charged exactly once and only for a
 * response we stored, and a retry with the same key replays it for free.
 */

export type Endpoint = 'records.search' | 'records.get' | 'changes.list';

export interface ShortBalance {
  buyerId: string;
  callId: string;
  priceMicros: number;
  balanceMicros: number;
}

/**
 * Hook for auto top-up (SP-047a). Called **outside** any transaction after the metering
 * transaction rolled back on a short balance. Return `true` to retry the charge once (e.g. a
 * vault top-up completed), `false` to record `PAYMENT_REQUIRED` and return 402. A throw counts
 * as `false`: the buyer gets the 402, not a 500.
 */
export type OnInsufficient = (short: ShortBalance) => Promise<boolean>;

export interface MeterContext {
  db: Db;
  buyerId: string;
  apiKeyId: string;
  channel: 'REST' | 'MCP';
  onInsufficient?: OnInsufficient;
  /** Clock for the auto key's minute bucket (tests). */
  now?: () => Date;
}

export interface ServedKey {
  key: string;
  hash: string;
}

export interface ChargeInput {
  dataset: { id: string };
  endpoint: Endpoint;
  /** The client's `Idempotency-Key`; omitted → `autoKey` (minute bucket). */
  idempotencyKey?: string;
  /** The canonical request (filters, sort, limit, cursor…); hashed into `request_hash`. */
  request: unknown;
  /** The fully built 200 response body, stored for replay. */
  body: unknown;
  /** Keys + hashes of the records served (kept 7 days for claims). */
  servedKeys: ServedKey[];
  unitPriceMicros: number;
  /** Records (or changes, for `changes.list`) in `body`. */
  count: number;
  isSimulated: boolean;
  /** SP-036's simulated week. Only for an `is_simulated` buyer with `isSimulated: true`. */
  simulatedAt?: Date;
  /** The 402 body (SP-017a's contract). Default: `INSUFFICIENT_BALANCE` with quote and balance. */
  paymentRequiredBody?: (q: {
    priceMicros: number;
    balanceMicros: number;
    count: number;
  }) => unknown;
}

export interface ChargeResult {
  /** HTTP status to send: 200, or 402 on a short balance (or the stored status on replay). */
  status: number;
  body: unknown;
  /** The buyer's balance after this call (`Spigot-Balance-Micros`). */
  balanceMicros: number;
  /** Charged by *this* request (`Spigot-Charged-Micros`): 0 on replay, 402 and NOT_CHARGED. */
  chargedMicros: number;
  callId: string;
  /** `Spigot-Replay: true`. */
  replay: boolean;
}

/** Thrown inside the transaction to roll it back so the auto top-up hook can run outside it. */
class RetryAfterShortBalance extends Error {
  constructor(readonly short: ShortBalance) {
    super('short balance: roll back for auto top-up');
  }
}

/** SIM charges are audited 1 in 20, deterministically by call id (feature 14). */
export const SIM_AUDIT_SAMPLE = 20;
export function simAuditSampled(callId: string): boolean {
  return createHash('sha256').update(callId).digest().readUInt32BE(0) % SIM_AUDIT_SAMPLE === 0;
}

interface Prepared {
  input: ChargeInput;
  idempotencyKey: string;
  requestHash: string;
  priceMicros: number;
}

export async function chargeAndRecord(
  ctx: MeterContext,
  input: ChargeInput,
): Promise<ChargeResult> {
  if (input.simulatedAt !== undefined && !input.isSimulated) {
    throw new TypeError('simulatedAt is only allowed with isSimulated: true');
  }
  // The dataset and endpoint are part of the request: the same key on another dataset is a mismatch.
  const hash = requestHash({
    dataset: input.dataset.id,
    endpoint: input.endpoint,
    request: input.request,
  });
  const p: Prepared = {
    input,
    requestHash: hash,
    idempotencyKey:
      input.idempotencyKey !== undefined
        ? checkClientKey(input.idempotencyKey)
        : autoKey(ctx.apiKeyId, hash, ctx.now?.() ?? new Date()),
    priceMicros: priceMicros(input.count, input.unitPriceMicros),
  };

  let hook = ctx.onInsufficient;
  for (;;) {
    try {
      return await ctx.db.tx((tx) => attempt(tx, ctx, p, hook !== undefined));
    } catch (err) {
      if (!(err instanceof RetryAfterShortBalance) || !hook) throw err;
      // Run once: whatever the hook says, the next attempt either charges or records the 402.
      const run = hook;
      hook = undefined;
      try {
        await run(err.short);
      } catch {
        // Auto top-up failed: fall through to PAYMENT_REQUIRED.
      }
    }
  }
}

async function buyerBalance(tx: Tx, buyerId: string): Promise<number> {
  const { rows } = await tx.query<{ balance: number }>(
    `SELECT balance_micros AS balance FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
    [buyerId],
  );
  return rows[0]?.balance ?? 0;
}

function replayResult(call: StoredCall, balanceMicros: number): ChargeResult {
  return {
    status: call.httpStatus ?? 200,
    body: call.responseBody,
    balanceMicros,
    chargedMicros: 0,
    callId: call.id,
    replay: true,
  };
}

function defaultPaymentRequiredBody(
  endpoint: Endpoint,
  q: { priceMicros: number; balanceMicros: number; count: number },
): unknown {
  return {
    ...errorEnvelope(
      'INSUFFICIENT_BALANCE',
      'Your balance is too low for this call. Top up to continue.',
    ),
    quote: {
      [endpoint === 'changes.list' ? 'changes' : 'records']: q.count,
      priceMicros: q.priceMicros,
    },
    balanceMicros: q.balanceMicros,
  };
}

async function attempt(
  tx: Tx,
  ctx: MeterContext,
  p: Prepared,
  hookArmed: boolean,
): Promise<ChargeResult> {
  const { input } = p;

  const buyer = await tx.query<{ isSimulated: boolean }>(
    `SELECT is_simulated AS "isSimulated" FROM buyers WHERE id = $1`,
    [ctx.buyerId],
  );
  if (!buyer.rows[0]) throw new Error(`chargeAndRecord: unknown buyer ${ctx.buyerId}`);
  if (input.simulatedAt !== undefined && !buyer.rows[0].isSimulated) {
    throw new TypeError('simulatedAt is only allowed for an is_simulated buyer');
  }

  // Commission is snapshotted now: a later rate change never re-splits this call (or its credits).
  const owner = await tx.query<{ publisherId: string; commissionBps: number }>(
    `SELECT p.id AS "publisherId", p.commission_bps AS "commissionBps"
     FROM datasets d JOIN sites s ON s.id = d.site_id JOIN publishers p ON p.id = s.publisher_id
     WHERE d.id = $1`,
    [input.dataset.id],
  );
  if (!owner.rows[0]) throw new Error(`chargeAndRecord: unknown dataset ${input.dataset.id}`);
  const { publisherId, commissionBps } = owner.rows[0];

  const claim = await claimCall(tx, {
    buyerId: ctx.buyerId,
    apiKeyId: ctx.apiKeyId,
    channel: ctx.channel,
    datasetId: input.dataset.id,
    endpoint: input.endpoint,
    idempotencyKey: p.idempotencyKey,
    requestHash: p.requestHash,
    isSimulated: input.isSimulated,
    simulatedAt: input.simulatedAt ?? null,
  });
  if (claim.kind === 'replay') return replayResult(claim.call, await buyerBalance(tx, ctx.buyerId));
  const { callId } = claim;

  const isChanges = input.endpoint === 'changes.list';
  // jsonb values are stringified: pg would send a JS array as a Postgres array literal.
  const snapshot = {
    unit_price_micros: input.unitPriceMicros,
    records_returned: isChanges ? null : input.count,
    changes_returned: isChanges ? input.count : null,
    commission_bps: commissionBps,
    served_record_keys: JSON.stringify(input.servedKeys),
  };

  if (p.priceMicros === 0) {
    await transition(tx, 'api_calls', callId, 'RECEIVED', 'NOT_CHARGED', {
      ...snapshot,
      price_micros: 0,
      http_status: 200,
      response_body: JSON.stringify(input.body),
    });
    return {
      status: 200,
      body: input.body,
      balanceMicros: await buyerBalance(tx, ctx.buyerId),
      chargedMicros: 0,
      callId,
      replay: false,
    };
  }

  const buyerAccount = await getOrCreateAccount(tx, 'BUYER_BALANCE', ctx.buyerId);
  const publisherAccount = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
  const platformRevenue = await getOrCreateAccount(tx, 'PLATFORM_REVENUE');

  let charged;
  try {
    charged = await post(tx, {
      kind: 'CHARGE',
      idempotencyKey: `charge:${callId}`,
      refType: 'api_call',
      refId: callId,
      entries: chargeEntries(
        { buyer: buyerAccount, publisher: publisherAccount, platformRevenue },
        p.priceMicros,
        commissionBps,
      ),
      isSimulated: input.isSimulated,
      ...(input.simulatedAt !== undefined ? { simulatedAt: input.simulatedAt } : {}),
    });
  } catch (err) {
    if (!(err instanceof InsufficientBalance)) throw err;
    // post() rolled back to its savepoint: this transaction is still usable.
    const balanceMicros = await buyerBalance(tx, ctx.buyerId);
    if (hookArmed) {
      throw new RetryAfterShortBalance({
        buyerId: ctx.buyerId,
        callId,
        priceMicros: p.priceMicros,
        balanceMicros,
      });
    }
    const q = { priceMicros: p.priceMicros, balanceMicros, count: input.count };
    const body = input.paymentRequiredBody?.(q) ?? defaultPaymentRequiredBody(input.endpoint, q);
    await transition(tx, 'api_calls', callId, 'RECEIVED', 'PAYMENT_REQUIRED', {
      ...snapshot,
      price_micros: 0,
      http_status: 402,
      response_body: JSON.stringify(body),
    });
    return { status: 402, body, balanceMicros, chargedMicros: 0, callId, replay: false };
  }

  await transition(tx, 'api_calls', callId, 'RECEIVED', 'CHARGED', {
    ...snapshot,
    price_micros: p.priceMicros,
    charge_txn_id: charged.txn.id,
    http_status: 200,
    response_body: JSON.stringify(input.body),
  });

  if (!input.isSimulated || simAuditSampled(callId)) {
    await tx.query(
      `INSERT INTO audit_events (at, actor_type, actor_id, publisher_id, entity, entity_id, action, data)
       VALUES (coalesce($1::timestamptz, now()), $2, $3, $4, 'api_call', $5, 'CALL_CHARGED', $6)`,
      [
        input.simulatedAt ?? null,
        input.isSimulated ? 'SIM' : ctx.channel === 'MCP' ? 'MCP_CLIENT' : 'BUYER',
        ctx.buyerId,
        publisherId,
        callId,
        JSON.stringify({
          datasetId: input.dataset.id,
          endpoint: input.endpoint,
          priceMicros: p.priceMicros,
          commissionBps,
          chargeTxnId: charged.txn.id,
          isSimulated: input.isSimulated,
        }),
      ],
    );
  }

  // Delivered on COMMIT only; ids, never amounts (SP-025 refetches).
  await notify(tx, PUBLISHER_EVENTS_CHANNEL, publisherEvent(publisherId, 'call.charged', [callId]));

  const balanceMicros = charged.replay
    ? await buyerBalance(tx, ctx.buyerId)
    : (charged.balances[buyerAccount] ?? (await buyerBalance(tx, ctx.buyerId)));
  return {
    status: 200,
    body: input.body,
    balanceMicros,
    chargedMicros: p.priceMicros,
    callId,
    replay: false,
  };
}
