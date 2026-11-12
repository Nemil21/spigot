// Paid MCP tools (api.md §MCP server; SP-022a): `search_records` and `get_changes`. Both go
// through SP-017a's `paidRead` with `channel: 'MCP'` (so `actor_type=MCP_CLIENT` in the audit),
// the same quotes, caps, 402s and idempotency as `/v1`.
import { z } from 'zod';
import { paidRead, type PaidReadParams } from '../../services/paidRead.js';
import { guard, ok, paidSummary, paymentResult } from '../results.js';
import {
  callerOf,
  idempotencyKeyFor,
  requireRead,
  type Caller,
  type ToolDeps,
  type ToolModule,
} from '../tools.js';
import { filtersInput, idempotencyKeyInput, maxPriceInput, siteDatasetInput } from '../inputs.js';

/** api.md's wording; the price is per dataset, so the example names where to read it. */
const RECORDS_COST =
  'Charges your Spigot balance per record returned (e.g. $0.0015 per record; describe_dataset ' +
  'shows each price). Call `quote` first if unsure. Nothing is charged if no records match.';
const CHANGES_COST =
  'Charges your Spigot balance per change returned (describe_dataset shows the price). Nothing ' +
  'is charged if nothing changed.';

const recordsOutput = {
  records: z.array(z.record(z.string(), z.unknown())),
  next: z.string().nullable(),
  charged: z.object({ records: z.number(), priceMicros: z.number() }),
  balanceMicros: z.number(),
  callId: z.string().nullable(),
  replay: z.boolean(),
};

const changesOutput = {
  changes: z.array(z.record(z.string(), z.unknown())),
  next: z.string(),
  hasMore: z.boolean(),
  charged: z.object({ changes: z.number(), priceMicros: z.number() }),
  balanceMicros: z.number(),
  callId: z.string().nullable(),
  replay: z.boolean(),
};

async function read(
  deps: ToolDeps,
  caller: Caller,
  params: Omit<PaidReadParams, 'idempotencyKey'>,
  clientKey: string | undefined,
) {
  const key = idempotencyKeyFor(caller, clientKey);
  return paidRead(
    {
      db: deps.db,
      buyerId: caller.buyerId,
      apiKeyId: caller.apiKeyId,
      channel: 'MCP',
      baseUrl: deps.baseUrl,
      ...(deps.now ? { now: deps.now } : {}),
    },
    { ...params, ...(key !== undefined ? { idempotencyKey: key } : {}) },
  );
}

const register: ToolModule = (server, deps) => {
  server.registerTool(
    'search_records',
    {
      title: 'Search records (paid)',
      description:
        `Returns typed records from a dataset that match the filters. ${RECORDS_COST} ` +
        'Use describe_dataset for the fields and ops you can filter on. When more records ' +
        'match than one call returns, pass the `next` cursor back as `cursor`.',
      inputSchema: {
        ...siteDatasetInput,
        filters: filtersInput,
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Records wanted (default 50, capped by the dataset).'),
        cursor: z.string().optional().describe('The `next` cursor of a previous call.'),
        maxPriceMicros: maxPriceInput,
        idempotencyKey: idempotencyKeyInput,
      },
      outputSchema: recordsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(deps.log, 'search_records', async () => {
        const caller = callerOf(extra);
        requireRead(caller);
        const res = await read(
          deps,
          caller,
          {
            site: args.site,
            dataset: args.dataset,
            kind: 'records',
            ...(args.filters !== undefined ? { filters: args.filters } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            ...(args.maxPriceMicros !== undefined ? { maxPriceMicros: args.maxPriceMicros } : {}),
          },
          args.idempotencyKey,
        );
        if (res.status !== 200) return paymentResult(res);
        const body = res.body as {
          records: Record<string, unknown>[];
          next: string | null;
          charged: { records: number; priceMicros: number };
          balanceMicros: number;
        };
        const summary = paidSummary({
          count: res.count,
          noun: args.dataset,
          chargedMicros: res.chargedMicros,
          balanceMicros: res.balanceMicros,
          replay: res.replay,
          ...(body.next
            ? { more: `More match: call again with cursor "${body.next}" for the next page.` }
            : {}),
        });
        return ok(summary, { ...body, callId: res.callId, replay: res.replay });
      }),
  );

  server.registerTool(
    'get_changes',
    {
      title: 'Get changes (paid)',
      description:
        'Returns what changed in a dataset since a cursor (JSON Patch per record; with ' +
        `includeRecord, the full record too). ${CHANGES_COST} Omit \`since\` to start from now; ` +
        'keep the returned `next` and pass it as `since` next time.',
      inputSchema: {
        ...siteDatasetInput,
        since: z
          .string()
          .optional()
          .describe('The `next` cursor from your previous get_changes call; "0" for everything.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Changes wanted (default 200, at most 1,000).'),
        includeRecord: z.boolean().optional().describe('Also return each changed record.'),
        maxPriceMicros: maxPriceInput,
        idempotencyKey: idempotencyKeyInput,
      },
      outputSchema: changesOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      guard(deps.log, 'get_changes', async () => {
        const caller = callerOf(extra);
        requireRead(caller);
        const res = await read(
          deps,
          caller,
          {
            site: args.site,
            dataset: args.dataset,
            kind: 'changes',
            ...(args.since !== undefined ? { cursor: args.since } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.includeRecord !== undefined ? { includeRecord: args.includeRecord } : {}),
            ...(args.maxPriceMicros !== undefined ? { maxPriceMicros: args.maxPriceMicros } : {}),
          },
          args.idempotencyKey,
        );
        if (res.status !== 200) return paymentResult(res);
        const body = res.body as {
          changes: Record<string, unknown>[];
          next: string;
          hasMore: boolean;
          charged: { changes: number; priceMicros: number };
          balanceMicros: number;
        };
        const summary = paidSummary({
          count: res.count,
          noun: 'changes',
          chargedMicros: res.chargedMicros,
          balanceMicros: res.balanceMicros,
          replay: res.replay,
          more: body.hasMore
            ? `More changes: call again with since "${body.next}".`
            : `Next time, pass since "${body.next}".`,
        });
        return ok(summary, { ...body, callId: res.callId, replay: res.replay });
      }),
  );
};

export default register;
