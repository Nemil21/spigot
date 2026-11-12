import { describe, expect, it, vi } from 'vitest';
import { aiProviderFor, loadConfig, MissingFeatureConfigError } from '../config.js';
import { createOpenAiTriageModel, RECOMMEND_TOOL, triageModelFor } from '../claims/triage.js';
import type { TriageContext } from '../claims/triage-context.js';
import {
  createOpenAiLiveModel,
  ModelUnavailableError,
  schemaModelFor,
} from '../schema-agent/claude.js';
import { REPAIR_FIELDS_TOOL } from '../schema-agent/repair.js';
import { PROPOSE_SCHEMA_TOOL } from '../schema-agent/tool.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  buildOpenAiToolBody,
  createOpenAiClient,
  DEFAULT_OPENAI_MODEL,
  OPENAI_CHAT_COMPLETIONS_URL,
  OpenAiHttpError,
} from './openai.js';

const KEY = 'sk-test-not-a-real-key';
const NO_WAIT = { delaysMs: [0, 0] };

function completion(toolName: string, args: unknown, over: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-5-2025-08-07',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: toolName,
                arguments: typeof args === 'string' ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 1000 },
    },
    ...over,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init!,
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('OpenAI request shape', () => {
  it('forces the one tool, sends max_completion_tokens, no temperature, key only in the header', async () => {
    const { fetch, calls } = fakeFetch(json(completion('recommend', { ok: 1 })));
    const client = createOpenAiClient({ apiKey: KEY, fetch });
    await client.callTool({
      model: 'gpt-5',
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'hi' }],
      tool: RECOMMEND_TOOL,
      maxCompletionTokens: 2000,
    });
    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0]!;
    expect(url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'recommend',
            description: RECOMMEND_TOOL.description,
            parameters: RECOMMEND_TOOL.input_schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'recommend' } },
      parallel_tool_calls: false,
      max_completion_tokens: 2000,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(String(init.body)).not.toContain(KEY);
  });

  it('translates the schema-agent tools unchanged', () => {
    for (const tool of [PROPOSE_SCHEMA_TOOL, REPAIR_FIELDS_TOOL]) {
      const body = buildOpenAiToolBody({
        model: 'm',
        system: 's',
        messages: [],
        tool,
        maxCompletionTokens: 1,
      });
      expect(body.tools[0]!.function.name).toBe(tool.name);
      expect(body.tools[0]!.function.parameters).toBe(tool.input_schema);
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: tool.name } });
    }
  });
});

describe('OpenAI response parsing', () => {
  it('returns the parsed tool arguments, usage and the answering model', async () => {
    const { fetch } = fakeFetch(json(completion('propose_schema', { typeName: 'Listing' })));
    const model = createOpenAiLiveModel({ apiKey: KEY, fetch, retry: NO_WAIT });
    const turn = await model.open({ pathPattern: '/x/:id', userPrompt: 'p' }).first();
    expect(turn).toEqual({
      input: { typeName: 'Listing' },
      usage: {
        inputTokens: 200,
        outputTokens: 300,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
      },
      model: 'gpt-5-2025-08-07',
      replayed: false,
      stopReason: 'tool_calls',
    });
    expect(model.modelId).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('no tool call, another tool, or bad JSON → input undefined', async () => {
    const noTool = completion('x', {});
    noTool.choices[0]!.message.tool_calls = [];
    const { fetch } = fakeFetch(
      json(noTool),
      json(completion('other_tool', { a: 1 })),
      json(completion('recommend', '{not json')),
    );
    const client = createOpenAiClient({ apiKey: KEY, fetch });
    const req = {
      model: 'gpt-5',
      system: 's',
      messages: [],
      tool: RECOMMEND_TOOL,
      maxCompletionTokens: 10,
    };
    for (let i = 0; i < 3; i++) expect((await client.callTool(req)).input).toBeUndefined();
  });

  it('retry turn continues the conversation with a tool message carrying the errors', async () => {
    const { fetch, calls } = fakeFetch(
      json(completion('propose_schema', { bad: true })),
      json(completion('propose_schema', { good: true })),
    );
    const conv = createOpenAiLiveModel({ apiKey: KEY, fetch, retry: NO_WAIT }).open({
      pathPattern: '/x',
      userPrompt: 'p',
    });
    await conv.first();
    const turn = await conv.retry(['fields: required']);
    expect(turn.input).toEqual({ good: true });
    const msgs = calls[1]!.body.messages as { role: string; content: string | null }[];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(msgs[3]!.content).toContain('fields: required');
  });

  it('repair uses repair_fields; triage uses recommend', async () => {
    const { fetch, calls } = fakeFetch(
      json(completion('repair_fields', { fields: [] })),
      json(completion('recommend', { decision: 'CREDIT', confidence: 0.7, reason: 'r' })),
    );
    const schema = createOpenAiLiveModel({ apiKey: KEY, fetch, retry: NO_WAIT });
    const rep = await schema.repair({ pathPattern: '/x', round: 1, userPrompt: 'fix' });
    expect(rep.input).toEqual({ fields: [] });
    const triage = createOpenAiTriageModel({
      apiKey: KEY,
      fetch,
      model: 'gpt-5-mini',
      retry: NO_WAIT,
    });
    const t = await triage.recommend({} as TriageContext, 'claim');
    expect(t).toMatchObject({
      input: { decision: 'CREDIT' },
      model: 'gpt-5-2025-08-07',
      replayed: false,
    });
    expect(calls[0]!.body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'repair_fields' },
    });
    expect(calls[1]!.body.model).toBe('gpt-5-mini');
    expect(calls[1]!.body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'recommend' },
    });
  });
});

describe('OpenAI retry policy', () => {
  it('retries 429 / 5xx / network errors, then succeeds', async () => {
    const { fetch, calls } = fakeFetch(
      json({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }),
      new TypeError('fetch failed'),
      json(completion('recommend', { decision: 'REJECT', confidence: 0.6, reason: 'r' })),
    );
    const triage = createOpenAiTriageModel({ apiKey: KEY, fetch, retry: NO_WAIT });
    const t = await triage.recommend({} as TriageContext, 'claim');
    expect(t.input).toMatchObject({ decision: 'REJECT' });
    expect(calls).toHaveLength(3);
  });

  it('three transient failures → ModelUnavailableError with the status', async () => {
    const { fetch, calls } = fakeFetch(json({}, 500), json({}, 503), json({}, 429));
    const model = createOpenAiLiveModel({ apiKey: KEY, fetch, retry: NO_WAIT });
    const err = await model
      .open({ pathPattern: '/x', userPrompt: 'p' })
      .first()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).attempts).toBe(3);
    expect((err as ModelUnavailableError).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  it('a 400 / 401 is not retried', async () => {
    const { fetch, calls } = fakeFetch(json({ error: { message: 'bad' } }, 401));
    const model = createOpenAiLiveModel({ apiKey: KEY, fetch, retry: NO_WAIT });
    const err = await model
      .repair({ pathPattern: '/x', round: 1, userPrompt: 'p' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });
});

describe('provider selection', () => {
  const cfg = (env: Record<string, string>) =>
    loadConfig({ ...REQUIRED_ENV, SCHEMA_AGENT_MODE: 'live', ...env });

  it('Anthropic key wins (unchanged); OpenAI only when it is the only key; AI_PROVIDER overrides', () => {
    expect(aiProviderFor(cfg({ ANTHROPIC_API_KEY: 'a' }))).toBe('anthropic');
    expect(aiProviderFor(cfg({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }))).toBe('anthropic');
    expect(aiProviderFor(cfg({ OPENAI_API_KEY: 'o' }))).toBe('openai');
    expect(aiProviderFor(cfg({}))).toBe('anthropic');
    expect(
      aiProviderFor(cfg({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', AI_PROVIDER: 'openai' })),
    ).toBe('openai');
    expect(aiProviderFor(cfg({ OPENAI_API_KEY: 'o', AI_PROVIDER: 'Anthropic' }))).toBe('anthropic');
  });

  it('live models pick the provider and its model id', () => {
    const openai = cfg({ OPENAI_API_KEY: 'o' });
    expect(schemaModelFor(openai)).toMatchObject({ mode: 'live', modelId: 'gpt-5' });
    expect(triageModelFor(openai)).toMatchObject({ mode: 'live', modelId: 'gpt-5' });
    const custom = cfg({
      OPENAI_API_KEY: 'o',
      OPENAI_MODEL: 'gpt-5-mini',
      CLAUDE_MODEL: 'claude-x',
    });
    expect(schemaModelFor(custom).modelId).toBe('gpt-5-mini');
    expect(triageModelFor(custom).modelId).toBe('gpt-5-mini');
    const anthropic = cfg({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      CLAUDE_MODEL: 'claude-x',
    });
    expect(schemaModelFor(anthropic).modelId).toBe('claude-x');
    expect(triageModelFor(anthropic).modelId).toBe('claude-x');
  });

  it('AI_PROVIDER=openai without OPENAI_API_KEY → MissingFeatureConfigError', () => {
    const c = cfg({ ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'openai' });
    expect(() => schemaModelFor(c)).toThrow(MissingFeatureConfigError);
    expect(() => triageModelFor(c)).toThrow(MissingFeatureConfigError);
  });

  it('rejects an unknown AI_PROVIDER', () => {
    expect(() => cfg({ AI_PROVIDER: 'gemini' })).toThrow();
  });
});
