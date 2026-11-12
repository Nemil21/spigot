// MCP tool results (features/11 §Logic 5 and 7; SP-022a). A tool answers with a one-line text
// summary the agent can narrate ("37 listings, charged $0.0555, balance $19.94") plus
// `structuredContent` with the typed payload it can reason over. Payment and request problems
// (402s, unknown fields, unpublished datasets) are tool results with `isError: true`, never
// protocol errors: an agent reads and acts on a tool result, and gives up on a transport error.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  formatCount,
  formatMicros,
  MONEY_WORDS,
  mcpInsufficientBalanceMessage,
  priceAboveMaxMessage,
  type ErrorCode,
} from '@spigot/shared';
import { ApiError } from '../http/errors.js';
import type { PaidReadResult } from '../services/paidRead.js';

export type ToolResult = CallToolResult;

/** A successful result: `summary` as text, `structured` as `structuredContent`. */
export function ok(summary: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

/** A tool error the agent should read: `isError`, the text, and `{ error: { code, … } }`. */
export function toolError(
  code: ErrorCode,
  text: string,
  structured: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { error: { code, message: text }, ...structured },
    isError: true,
  };
}

interface ValidFilter {
  field: string;
  ops: string[];
}

/** "bedrooms (eq, gte, lte); city (eq, in); updated_at (gte)" */
export function validFiltersLine(valid: readonly ValidFilter[]): string {
  return valid.map((f) => `${f.field} (${f.ops.join(', ')})`).join('; ');
}

/** An `ApiError` from a service as a tool error, with a hint the agent can act on. */
export function fromApiError(err: ApiError): ToolResult {
  const details = err.details ?? {};
  switch (err.code) {
    case 'UNSUPPORTED_FILTER': {
      const valid = (details.validFilters as ValidFilter[] | undefined) ?? [];
      return toolError(err.code, `${err.message} Valid filters: ${validFiltersLine(valid)}.`, {
        validFilters: valid,
      });
    }
    case 'NOT_FOUND':
      return toolError(
        err.code,
        `${err.message} Call list_datasets to see which sites and datasets are for sale.`,
      );
    default:
      return toolError(err.code, err.message, Object.keys(details).length ? { details } : {});
  }
}

/**
 * Runs a tool body; an `ApiError` becomes a tool error. Anything else is logged and becomes a
 * generic tool error, so internals never reach the agent.
 */
export async function guard(
  log: { error: (obj: unknown, msg: string) => void },
  tool: string,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ApiError) return fromApiError(err);
    log.error({ err, tool }, 'mcp tool failed');
    return toolError('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
  }
}

/** "37 listings", "1 listing", "0 changes". */
export function countNoun(n: number, plural: string): string {
  const noun = n === 1 && plural.endsWith('s') ? plural.slice(0, -1) : plural;
  return `${formatCount(n)} ${noun}`;
}

interface Body402 {
  error: { code: ErrorCode; message: string };
  quote?: { records?: number; changes?: number; priceMicros: number };
  balanceMicros?: number;
  maxPriceMicros?: number;
  topUpUrl?: string;
  top_up?: { tool: 'top_up'; amountCents: number };
}

/**
 * A 402 from `paidRead` as a tool error with the W15 MCP copy: "This call costs $0.0555; balance
 * $0.012. Ask me to top up, or open <url>." The full 402 body rides along as `structuredContent`.
 */
export function paymentResult(res: PaidReadResult): ToolResult {
  const body = res.body as Body402;
  const code = body.error.code;
  const priceMicros = body.quote?.priceMicros ?? 0;
  if (code === 'INSUFFICIENT_BALANCE') {
    const text = mcpInsufficientBalanceMessage({
      priceMicros,
      balanceMicros: body.balanceMicros ?? res.balanceMicros,
      topUpUrl: body.topUpUrl ?? '',
    });
    return toolError(code, text, { ...body, error: { code, message: text } });
  }
  if (code === 'PRICE_ABOVE_MAX') {
    const text = priceAboveMaxMessage({
      records: body.quote?.records ?? body.quote?.changes ?? 0,
      priceMicros,
      maxPriceMicros: body.maxPriceMicros ?? 0,
      param: 'maxPriceMicros',
    });
    return toolError(code, text, { ...body, error: { code, message: text } });
  }
  return toolError(code, body.error.message, { ...body });
}

/**
 * The summary line for a paid read: "37 listings, charged $0.0555, balance $19.94". A replay
 * says it wasn't charged again; an empty result says nothing was charged. "charged" appears only
 * when this call's CHARGE posted (screens.md money copy rule).
 */
export function paidSummary(args: {
  count: number;
  noun: string;
  chargedMicros: number;
  balanceMicros: number;
  replay: boolean;
  more?: string;
}): string {
  const what = countNoun(args.count, args.noun);
  const balance = `balance ${formatMicros(args.balanceMicros)}`;
  const money = args.replay
    ? `a repeat of an earlier call, not ${MONEY_WORDS.charged} again`
    : args.chargedMicros > 0
      ? `${MONEY_WORDS.charged} ${formatMicros(args.chargedMicros)}`
      : `nothing ${MONEY_WORDS.charged}`;
  return `${what}, ${money}, ${balance}.${args.more ? ` ${args.more}` : ''}`;
}
