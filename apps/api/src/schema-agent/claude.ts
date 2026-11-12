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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { requireKeys, type Config } from '../config.js';
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
}

/** One model call: the `propose_schema` input (unvalidated), or `undefined` if it wasn't called. */
export interface ModelTurn {
  input: unknown;
  usage: TokenUsage;
  /** Model that actually answered (a server-side fallback may differ from the requested one). */
  model: string;
  replayed: boolean;
  stopReason: string | null;
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
}

/** No recorded response for this template (recorded mode): the template is skipped. */
export class RecordedProposalMissingError extends Error {
  override name = 'RecordedProposalMissingError';
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

let prompts: { system: string; dsl: string } | undefined;
export function loadPrompts(): { system: string; dsl: string } {
  prompts ??= {
    system: readFileSync(assetPath('prompts/system.md'), 'utf8'),
    dsl: readFileSync(assetPath('prompts/dsl.md'), 'utf8'),
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
}

export function createLiveModel(opts: LiveModelOptions): SchemaModel {
  const modelId = opts.model ?? DEFAULT_CLAUDE_MODEL;
  // The SDK retries 408/409/429/5xx and connection errors with backoff.
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 120_000 });
  const { system, dsl } = loadPrompts();
  // tools render before system: one breakpoint on the last system block caches tool + both.
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: system },
    { type: 'text', text: dsl, cache_control: { type: 'ephemeral' } },
  ];

  return {
    mode: 'live',
    modelId,
    open(req) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: 'user', content: req.userPrompt },
      ];
      let last: Anthropic.Beta.BetaMessage | undefined;

      const call = async (): Promise<ModelTurn> => {
        const res = await client.beta.messages.create({
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
        const tool = res.content.find(
          (b): b is Anthropic.Beta.BetaToolUseBlock =>
            b.type === 'tool_use' && b.name === PROPOSE_SCHEMA_TOOL_NAME,
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
  };
}

// --- recorded ----------------------------------------------------------------------------------

export interface RecordedProposal {
  /** Template display pattern this response answers, e.g. `/listings/:slug`. */
  pathPattern: string;
  model: string;
  /** `hand-authored` until a live run replaces it (copy `input` from its SCHEMA_PROPOSED audit row, `data.proposal`). */
  source: 'hand-authored' | 'live-capture';
  capturedAt?: string;
  usage?: Partial<TokenUsage>;
  /** The `propose_schema` input. */
  input: unknown;
  /** Optional second answer for the retry turn; defaults to `input` again. */
  retryInput?: unknown;
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
    if (out.has(rec.pathPattern)) throw new Error(`recorded/${file}: duplicate ${rec.pathPattern}`);
    out.set(rec.pathPattern, rec);
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
      const rec = recorded.get(req.pathPattern);
      const need = () => {
        if (!rec) {
          throw new RecordedProposalMissingError(`no recorded proposal for ${req.pathPattern}`);
        }
        return rec;
      };
      return {
        first: async () => turn(need(), need().input),
        retry: async () => turn(need(), need().retryInput ?? need().input),
      };
    },
  };
}

/** The model for this config: recorded replay, or live (needs `ANTHROPIC_API_KEY`). */
export function schemaModelFor(config: Config): SchemaModel {
  if (config.SCHEMA_AGENT_MODE === 'recorded') return createRecordedModel();
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
