// OpenAI Chat Completions adapter for the AI features (schema agent, claims triage), used when
// only `OPENAI_API_KEY` is set (`aiProviderFor` in config.ts). Plain `fetch`, no SDK.
//
// One request = one forced tool call: the Anthropic tool definitions (`name`, `description`,
// `input_schema`) become a `function` tool and `tool_choice` names it. No `temperature` (the
// gpt-5 family rejects non-default values) and `max_completion_tokens` instead of `max_tokens`.
// The tool call's JSON arguments are returned as the same unvalidated `input` the Anthropic path
// returns, so the Zod validation downstream is unchanged. Errors are typed so the shared retry
// policy (`withModelRetry`) can tell transient ones (429 / 5xx / network) from the rest.

export const DEFAULT_OPENAI_MODEL = 'gpt-5';
export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRY_AFTER_MS = 30_000;

/** The tool shape both providers share (an Anthropic `Tool`). */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A non-2xx answer. `status` drives the retry decision. */
export class OpenAiHttpError extends Error {
  override name = 'OpenAiHttpError';
  constructor(
    readonly status: number,
    /** From `retry-after` (seconds), capped at 30 s; 0 if absent. */
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
  }
}

/** The request never got an answer (DNS, reset, timeout). Always transient. */
export class OpenAiConnectionError extends Error {
  override name = 'OpenAiConnectionError';
}

export interface OpenAiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface OpenAiToolResult {
  /** Parsed arguments of the named tool call, or `undefined` if it wasn't called / not JSON. */
  input: unknown;
  /** The assistant message as received (to continue the conversation on a retry). */
  assistant: Extract<OpenAiMessage, { role: 'assistant' }>;
  /** Id of the named tool call, if any. */
  toolCallId: string | undefined;
  usage: OpenAiUsage;
  model: string;
  stopReason: string | null;
}

export interface OpenAiToolRequest {
  model: string;
  system: string;
  messages: OpenAiMessage[];
  tool: ToolDefinition;
  maxCompletionTokens: number;
}

export interface OpenAiClientOptions {
  apiKey: string;
  /** Tests inject a fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

export function toOpenAiTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  };
}

/** The request body (exported for tests). No secrets: the key only goes in the header. */
export function buildOpenAiToolBody(req: OpenAiToolRequest) {
  return {
    model: req.model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    tools: [toOpenAiTool(req.tool)],
    tool_choice: { type: 'function', function: { name: req.tool.name } },
    parallel_tool_calls: false,
    max_completion_tokens: req.maxCompletionTokens,
  };
}

interface ChatCompletion {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[]; refusal?: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

function retryAfter(res: Response): number {
  const secs = Number(res.headers.get('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : 0;
}

export function createOpenAiClient(opts: OpenAiClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const url = opts.url ?? OPENAI_CHAT_COMPLETIONS_URL;

  return {
    async callTool(req: OpenAiToolRequest): Promise<OpenAiToolResult> {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(buildOpenAiToolBody(req)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new OpenAiConnectionError(
          `OpenAI request failed: ${err instanceof Error ? err.name : 'unknown'}`,
          { cause: err },
        );
      }
      if (!res.ok) {
        // The error body names the problem (never echoes the key); keep it short for logs.
        const text = await res.text().catch(() => '');
        throw new OpenAiHttpError(
          res.status,
          retryAfter(res),
          `OpenAI ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const body = (await res.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      const message = choice?.message;
      const call = message?.tool_calls?.find(
        (c) => c.type === 'function' && c.function?.name === req.tool.name,
      );
      let input: unknown;
      if (call && !message?.refusal) {
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = undefined;
        }
      }
      const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        input,
        assistant: {
          role: 'assistant',
          content: message?.content ?? null,
          ...(message?.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        },
        toolCallId: call?.id,
        usage: {
          // Anthropic counts cache reads separately from input; mirror that split.
          inputTokens: Math.max(0, (body.usage?.prompt_tokens ?? 0) - cached),
          outputTokens: body.usage?.completion_tokens ?? 0,
          cacheReadInputTokens: cached,
          cacheCreationInputTokens: 0,
        },
        model: body.model ?? req.model,
        stopReason: message?.refusal ? 'refusal' : (choice?.finish_reason ?? null),
      };
    },
  };
}

export type OpenAiClient = ReturnType<typeof createOpenAiClient>;
