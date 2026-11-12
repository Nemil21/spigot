// The model seam of the schema agent (features/04 §2, §Prompting notes).
//
// `live`: one Anthropic Messages call per template, one tool (`propose_schema`), system prompt +
// DSL reference cached (prompt caching), `CLAUDE_MODEL` (default `claude-opus-5-5`).
// `recorded` (`SCHEMA_AGENT_MODE=recorded`): replays `recorded/*.json` by template path pattern,
// with no network call (CI and fast retakes; the audit row says "replayed proposal").
//
// Two API facts shape the live request (see the PR): current models reject forced tool use
// (`tool_choice: tool`) and, since 2026-10-21, any `temperature`, so we send `tool_choice: auto`
// with a system instruction to call the one tool, and leave sampling at the API default. The
// output is validated by Zod either way, and an answer without the tool call is a retry.
//
// SP-012b: `repair()` is the self-check's `repair_fields` turn (a fresh call, same cached system
// prompt + DSL, one tool). Every live request is tried 3 times with backoff on overload / rate
// limit / 5xx / connection errors (the SDK's own retries are off, so 3 means 3); after that it
// throws `ModelUnavailableError` and the proposal falls back to the JSON-LD-only auto-schema.
//
// With only `OPENAI_API_KEY` set (`aiProviderFor`), `live` runs the same seam on OpenAI Chat
// Completions instead (`createOpenAiLiveModel`, adapter in ai/openai.ts): same tools, prompts,
// retry policy and fallback; the audit rows record whichever model answered.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  createOpenAiClient,
  DEFAULT_OPENAI_MODEL,
  OpenAiConnectionError,
  OpenAiHttpError,
  type OpenAiMessage,
} from '../ai/openai.js';
import { aiProviderFor, requireKeys, type Config } from '../config.js';
import { REPAIR_FIELDS_TOOL, REPAIR_FIELDS_TOOL_NAME } from './repair.js';
import { PROPOSE_SCHEMA_TOOL, PROPOSE_SCHEMA_TOOL_NAME } from './tool.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16_000;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

export interface ProposeRequest {
  /** Display pattern from clustering, e.g. `/listings/:slug`; recorded mode keys on it. */
  pathPattern: string;
  /** The per-template user message (`buildUserPrompt`). */
  userPrompt: string;
  /** SP-052b: `reinfer` = re-proposal after drift (recorded mode keys on `reinfer:<pattern>`). */
  variant?: ProposalVariant;
}

/** `reinfer`: the re-proposal for a changed layout, seeded with the old schema (SP-052b). */
export type ProposalVariant = 'reinfer';

/** Recorded-mode key: the path pattern, prefixed with the variant when there is one. */
export const recordedKey = (pathPattern: string, variant?: ProposalVariant) =>
  variant ? `${variant}:${pathPattern}` : pathPattern;

/** One model call: the `propose_schema` input (unvalidated), or `undefined` if it wasn't called. */
export interface ModelTurn {
  input: unknown;
  usage: TokenUsage;
  /** Model that actually answered (a server-side fallback may differ from the requested one). */
  model: string;
  replayed: boolean;
  stopReason: string | null;
}

/** One `repair_fields` turn of the self-check (features/04 §4; at most 2 per template). */
export interface RepairRequest {
  pathPattern: string;
  /** 1 or 2. */
  round: number;
  /** The repair user message (`buildRepairPrompt`). */
  userPrompt: string;
  variant?: ProposalVariant;
}

export interface ProposalConversation {
  first(): Promise<ModelTurn>;
  /** Second (and last) attempt: the previous answer failed validation with these errors. */
  retry(errors: string[]): Promise<ModelTurn>;
}

export interface SchemaModel {
  readonly mode: 'live' | 'recorded';
  readonly modelId: string;
  open(req: ProposeRequest): ProposalConversation;
  /** A `repair_fields` call: `input` is the unvalidated tool input, or `undefined`. */
  repair(req: RepairRequest): Promise<ModelTurn>;
}

/** No recorded response for this template (recorded mode): the template is skipped. */
export class RecordedProposalMissingError extends Error {
  override name = 'RecordedProposalMissingError';
}

/**
 * The model is overloaded, rate-limited or unreachable after every retry (features/04 §Edge
 * cases): the template gets the JSON-LD-only auto-schema instead of an AI proposal.
 */
export class ModelUnavailableError extends Error {
  override name = 'ModelUnavailableError';
  constructor(
    message: string,
    readonly attempts: number,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Worth retrying: timeout, conflict, rate limit, 5xx (incl. 529 overloaded), connection error. */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof OpenAiConnectionError) return true;
  if (err instanceof OpenAiHttpError) {
    const s = err.status;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  const s = err.status;
  return s === 408 || s === 409 || s === 429 || (typeof s === 'number' && s >= 500);
}

export const MODEL_ATTEMPTS = 3;
/** Wait before attempt 2 and 3; a `retry-after` header (≤ 30 s) wins when longer. */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

function retryAfterMs(err: unknown): number {
  if (err instanceof OpenAiHttpError) return err.retryAfterMs;
  if (!(err instanceof Anthropic.APIError)) return 0;
  const raw = err.headers?.get?.('retry-after');
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : 0;
}

/**
 * `fn` up to `MODEL_ATTEMPTS` times while it fails with a transient error; then
 * `ModelUnavailableError`. Other errors (400, 401, a bug) propagate at once.
 */
export async function withModelRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientModelError(err)) throw err;
      if (attempt >= MODEL_ATTEMPTS) {
        const status =
          err instanceof Anthropic.APIError
            ? (err.status ?? null)
            : err instanceof OpenAiHttpError
              ? err.status
              : null;
        throw new ModelUnavailableError(
          `model unavailable after ${attempt} tries (${status ?? 'connection error'})`,
          attempt,
          status,
          { cause: err },
        );
      }
      await sleep(Math.max(delays[attempt - 1] ?? delays.at(-1) ?? 0, retryAfterMs(err)));
    }
  }
}

// --- prompts -----------------------------------------------------------------------------------

/**
 * Path of a file that ships next to this module's source (`prompts/`, `recorded/`). tsc doesn't
 * copy non-TS files, so from `dist/` we fall back to the same path under `src/`.
 */
export function assetPath(rel: string): string {
  const here = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(here)) return here;
  const src = fileURLToPath(new URL(`../../src/schema-agent/${rel}`, import.meta.url));
  return existsSync(src) ? src : here;
}

let prompts: { system: string; dsl: string; repair: string } | undefined;
export function loadPrompts(): { system: string; dsl: string; repair: string } {
  prompts ??= {
    system: readFileSync(assetPath('prompts/system.md'), 'utf8'),
    dsl: readFileSync(assetPath('prompts/dsl.md'), 'utf8'),
    repair: readFileSync(assetPath('prompts/repair.md'), 'utf8'),
  };
  return prompts;
}

// --- live --------------------------------------------------------------------------------------

function usageOf(u: Anthropic.Beta.BetaUsage | undefined): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export interface LiveModelOptions {
  apiKey: string;
  model?: string;
  /** Tests inject a client. */
  client?: Pick<Anthropic, 'beta'>;
  /** Backoff between the 3 tries (tests pass zeros). */
  retry?: RetryOptions;
}

export function createLiveModel(opts: LiveModelOptions): SchemaModel {
  const modelId = opts.model ?? DEFAULT_CLAUDE_MODEL;
  // `withModelRetry` owns retries (3 tries, then the JSON-LD fallback), so the SDK makes one.
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, timeout: 120_000 });
  const create = (body: Anthropic.Beta.MessageCreateParamsNonStreaming) =>
    withModelRetry(() => client.beta.messages.create(body), opts.retry);
  const { system, dsl, repair } = loadPrompts();
  // tools render before system: one breakpoint on the last system block caches tool + both.
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: system },
    { type: 'text', text: dsl, cache_control: { type: 'ephemeral' } },
  ];
  // Repair turns: same rules + DSL, then the repair instructions (which narrow the output tool).
  const repairSystem: Anthropic.Beta.BetaTextBlockParam[] = [
    ...systemBlocks,
    { type: 'text', text: repair },
  ];
  const toTurn = (res: Anthropic.Beta.BetaMessage, toolName: string): ModelTurn => {
    const tool = res.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === toolName,
    );
    return {
      input: res.stop_reason === 'refusal' ? undefined : tool?.input,
      usage: usageOf(res.usage),
      model: res.model,
      replayed: false,
      stopReason: res.stop_reason ?? null,
    };
  };

  return {
    mode: 'live',
    modelId,
    open(req) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: 'user', content: req.userPrompt },
      ];
      let last: Anthropic.Beta.BetaMessage | undefined;

      const call = async (): Promise<ModelTurn> => {
        const res = await create({
          model: modelId,
          max_tokens: MAX_TOKENS,
          system: systemBlocks,
          tools: [PROPOSE_SCHEMA_TOOL],
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          output_config: { effort: 'medium' },
          // Opt-in server-side fallback on a policy decline (routes by refusal category).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          messages,
        });
        last = res;
        return toTurn(res, PROPOSE_SCHEMA_TOOL_NAME);
      };

      return {
        first: call,
        async retry(errors) {
          const feedback =
            'Your propose_schema input was rejected. Fix these problems and call propose_schema ' +
            'again with the complete corrected proposal:\n- ' +
            errors.join('\n- ');
          const tool = last?.content.find(
            (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
          );
          if (last) messages.push({ role: 'assistant', content: last.content });
          messages.push({
            role: 'user',
            content: tool
              ? [{ type: 'tool_result', tool_use_id: tool.id, is_error: true, content: feedback }]
              : feedback,
          });
          return call();
        },
      };
    },
    async repair(req) {
      const res = await create({
        model: modelId,
        max_tokens: MAX_TOKENS,
        system: repairSystem,
        tools: [REPAIR_FIELDS_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: req.userPrompt }],
      });
      return toTurn(res, REPAIR_FIELDS_TOOL_NAME);
    },
  };
}

// --- live (OpenAI) -----------------------------------------------------------------------------

export interface OpenAiLiveModelOptions {
  apiKey: string;
  model?: string;
  /** Tests inject a fetch. */
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

/** The `live` seam on OpenAI Chat Completions: one forced tool call per request. */
export function createOpenAiLiveModel(opts: OpenAiLiveModelOptions): SchemaModel {
  const modelId = opts.model ?? DEFAULT_OPENAI_MODEL;
  const client = createOpenAiClient({ apiKey: opts.apiKey, fetch: opts.fetch });
  const { system, dsl, repair } = loadPrompts();
  const systemText = `${system}\n\n${dsl}`;
  const repairSystemText = `${systemText}\n\n${repair}`;
  const toTurn = (r: Awaited<ReturnType<typeof client.callTool>>): ModelTurn => ({
    input: r.input,
    usage: r.usage,
    model: r.model,
    replayed: false,
    stopReason: r.stopReason,
  });

  return {
    mode: 'live',
    modelId,
    open(req) {
      const messages: OpenAiMessage[] = [{ role: 'user', content: req.userPrompt }];
      let last: Awaited<ReturnType<typeof client.callTool>> | undefined;
      const call = async (): Promise<ModelTurn> => {
        const res = await withModelRetry(
          () =>
            client.callTool({
              model: modelId,
              system: systemText,
              messages,
              tool: PROPOSE_SCHEMA_TOOL,
              maxCompletionTokens: MAX_TOKENS,
            }),
          opts.retry,
        );
        last = res;
        return toTurn(res);
      };
      return {
        first: call,
        async retry(errors) {
          const feedback =
            'Your propose_schema input was rejected. Fix these problems and call propose_schema ' +
            'again with the complete corrected proposal:\n- ' +
            errors.join('\n- ');
          if (last) {
            messages.push(last.assistant);
            // Every tool call needs a tool answer before the next user turn.
            for (const tc of last.assistant.tool_calls ?? []) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: tc.id === last.toolCallId ? feedback : 'Ignored.',
              });
            }
          }
          if (!last?.toolCallId) messages.push({ role: 'user', content: feedback });
          return call();
        },
      };
    },
    async repair(req) {
      const res = await withModelRetry(
        () =>
          client.callTool({
            model: modelId,
            system: repairSystemText,
            messages: [{ role: 'user', content: req.userPrompt }],
            tool: REPAIR_FIELDS_TOOL,
            maxCompletionTokens: MAX_TOKENS,
          }),
        opts.retry,
      );
      return toTurn(res);
    },
  };
}

// --- recorded ----------------------------------------------------------------------------------

export interface RecordedProposal {
  /** Template display pattern this response answers, e.g. `/listings/:slug`. */
  pathPattern: string;
  /** SP-052b: `reinfer` answers the re-proposal after drift (same pattern, new layout). */
  variant?: ProposalVariant;
  model: string;
  /** `hand-authored` until a live run replaces it (copy `input` from its SCHEMA_PROPOSED audit row, `data.proposal`). */
  source: 'hand-authored' | 'live-capture';
  capturedAt?: string;
  usage?: Partial<TokenUsage>;
  /** The `propose_schema` input. */
  input: unknown;
  /** Optional second answer for the retry turn; defaults to `input` again. */
  retryInput?: unknown;
  /** `repair_fields` inputs for self-check rounds 1 and 2 (none → no repair, the field is dropped). */
  repairs?: unknown[];
}

export const RECORDED_DIR = 'recorded/';

export function loadRecorded(dir: string = assetPath(RECORDED_DIR)): Map<string, RecordedProposal> {
  const out = new Map<string, RecordedProposal>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const rec = JSON.parse(
      readFileSync(`${dir.replace(/\/$/, '')}/${file}`, 'utf8'),
    ) as RecordedProposal;
    if (typeof rec.pathPattern !== 'string')
      throw new Error(`recorded/${file}: missing pathPattern`);
    const key = recordedKey(rec.pathPattern, rec.variant);
    if (out.has(key)) throw new Error(`recorded/${file}: duplicate ${key}`);
    out.set(key, rec);
  }
  return out;
}

export function createRecordedModel(
  recorded: ReadonlyMap<string, RecordedProposal> = loadRecorded(),
): SchemaModel {
  const turn = (rec: RecordedProposal, input: unknown): ModelTurn => ({
    input: structuredClone(input),
    usage: { ...ZERO_USAGE, ...rec.usage },
    model: rec.model,
    replayed: true,
    stopReason: 'tool_use',
  });
  return {
    mode: 'recorded',
    modelId: 'recorded',
    open(req) {
      const key = recordedKey(req.pathPattern, req.variant);
      const rec = recorded.get(key);
      const need = () => {
        if (!rec) {
          throw new RecordedProposalMissingError(`no recorded proposal for ${key}`);
        }
        return rec;
      };
      return {
        first: async () => turn(need(), need().input),
        retry: async () => turn(need(), need().retryInput ?? need().input),
      };
    },
    async repair(req) {
      const key = recordedKey(req.pathPattern, req.variant);
      const rec = recorded.get(key);
      const input = rec?.repairs?.[req.round - 1];
      if (!rec || input === undefined) {
        throw new RecordedProposalMissingError(`no recorded repair round ${req.round} for ${key}`);
      }
      return turn(rec, input);
    },
  };
}

/**
 * The model for this config: recorded replay, or live on Anthropic (`ANTHROPIC_API_KEY`) or, when
 * only `OPENAI_API_KEY` is set (or `AI_PROVIDER=openai`), on OpenAI.
 */
export function schemaModelFor(config: Config): SchemaModel {
  if (config.SCHEMA_AGENT_MODE === 'recorded') return createRecordedModel();
  if (aiProviderFor(config) === 'openai') {
    const { OPENAI_API_KEY } = requireKeys(config, 'Schema agent (live mode)', 'OPENAI_API_KEY');
    return createOpenAiLiveModel({
      apiKey: OPENAI_API_KEY,
      model: config.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
    });
  }
  const { ANTHROPIC_API_KEY } = requireKeys(
    config,
    'Schema agent (live mode)',
    'ANTHROPIC_API_KEY',
  );
  return createLiveModel({
    apiKey: ANTHROPIC_API_KEY,
    model: config.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL,
  });
}
