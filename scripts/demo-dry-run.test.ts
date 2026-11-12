import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  judgeAgentRun,
  mcpConfig,
  parseClaudeStream,
  parseSimWeekGross,
  redact,
  reportMarkdown,
  usd,
} from './demo-dry-run.lib.js';

const ev = (o: unknown) => JSON.stringify(o);
const toolUse = (name: string) =>
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } });
const toolResult = (text: string) =>
  ev({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] },
  });
const result = (text: string, extra: Record<string, unknown> = {}) =>
  ev({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.12,
    num_turns: 9,
    ...extra,
  });

const goodTake = [
  ev({ type: 'system', subtype: 'init' }),
  toolUse('ToolSearch'),
  toolUse('mcp__spigot__list_datasets'),
  toolResult('{"datasets":[{"site":"bluebonnet","dataset":"listings"}]}'),
  toolUse('mcp__spigot__describe_dataset'),
  toolUse('mcp__spigot__quote'),
  toolResult('{"records":37,"display":"$0.0555"}'),
  toolUse('mcp__spigot__search_records'),
  toolResult('{"records":[{"title":"3br","price_usd":1800}],"charged":{"records":37}}'),
  'not json: stray stderr',
  result('37 listings, charged $0.0555 from your PayPal-funded Spigot balance.'),
].join('\n');

describe('parseClaudeStream', () => {
  it('reads Spigot tool calls in order, ignores ToolSearch and non-JSON lines', () => {
    const t = parseClaudeStream(goodTake);
    expect(t.tools).toEqual(['list_datasets', 'describe_dataset', 'quote', 'search_records']);
    expect(t.otherTools).toEqual([]);
    expect(t.finalText).toContain('PayPal-funded');
    expect(t.toolResultText).toContain('"records":37');
    expect(t).toMatchObject({ isError: false, costUsd: 0.12, numTurns: 9 });
  });

  it('records other tools and an error result', () => {
    const t = parseClaudeStream(
      [toolUse('Bash'), result('', { subtype: 'error_max_turns', is_error: true })].join('\n'),
    );
    expect(t.otherTools).toEqual(['Bash']);
    expect(t.isError).toBe(true);
  });
});

describe('judgeAgentRun (prompt card re-take rules)', () => {
  it('passes a take that quotes first and hides agent_phone', () => {
    expect(judgeAgentRun(parseClaudeStream(goodTake))).toEqual({ ok: true, problems: [] });
  });

  it('re-take: fetched before quoting', () => {
    const t = parseClaudeStream(
      [toolUse('mcp__spigot__search_records'), toolUse('mcp__spigot__quote'), result('ok')].join(
        '\n',
      ),
    );
    expect(judgeAgentRun(t).problems).toContain('fetched before quoting');
  });

  it('re-take: skipped quote, or never fetched', () => {
    expect(
      judgeAgentRun(
        parseClaudeStream([toolUse('mcp__spigot__get_changes'), result('ok')].join('\n')),
      ).problems,
    ).toContain('never called quote');
    expect(
      judgeAgentRun(parseClaudeStream([toolUse('mcp__spigot__quote'), result('ok')].join('\n')))
        .problems,
    ).toContain('never called search_records / get_changes');
  });

  it('get_changes counts as the paid fetch ("changed today")', () => {
    const t = parseClaudeStream(
      [toolUse('mcp__spigot__quote'), toolUse('mcp__spigot__get_changes'), result('ok')].join('\n'),
    );
    expect(judgeAgentRun(t).ok).toBe(true);
  });

  it('re-take: a hidden field in a tool result or the reply', () => {
    const leaked = `${goodTake}\n${toolResult('{"records":[{"agent_phone":"512-555-0100"}]}')}`;
    expect(judgeAgentRun(parseClaudeStream(leaked)).problems).toContain(
      'hidden field agent_phone leaked',
    );
    const inReply = `${toolUse('mcp__spigot__quote')}\n${toolUse('mcp__spigot__search_records')}\n${result('agent_phone: 512-555-0100')}`;
    expect(judgeAgentRun(parseClaudeStream(inReply)).ok).toBe(false);
  });
});

describe('mcpConfig / redact', () => {
  it('builds the claude --mcp-config shape for an HTTP server', () => {
    expect(mcpConfig('http://localhost:3000/', 'sk_live_abc')).toEqual({
      mcpServers: {
        spigot: {
          type: 'http',
          url: 'http://localhost:3000/mcp',
          headers: { Authorization: 'Bearer sk_live_abc' },
        },
      },
    });
    expect(ALLOWED_TOOLS).toContain('mcp__spigot__quote');
    expect(ALLOWED_TOOLS.some((t) => t.endsWith('top_up'))).toBe(false);
  });

  it('never lets a key through', () => {
    expect(
      redact('key sk_abcdef123 gate gk_XYZ987abc crawl ck_q1w2e3r4 Authorization: Bearer abc.def'),
    ).toBe('key sk_… gate gk_… crawl ck_… Authorization: Bearer …');
  });
});

describe('usd / reportMarkdown', () => {
  it('formats micros', () => {
    expect(usd(55_500)).toBe('$0.0555');
    expect(usd(75_000)).toBe('$0.0750');
    expect(usd(20_000_000)).toBe('$20.00');
    expect(usd(0)).toBe('$0.00');
  });

  it('renders one row per step, escapes pipes and redacts', () => {
    const md = reportMarkdown(
      'Run 1',
      [
        { row: '2.1', name: 'Crawl', ok: true, detail: 'run abc | 2482 pages', ms: 125_000 },
        { row: '6.2', name: 'Agent', ok: false, detail: 'key sk_secret123 refused', ms: 1000 },
      ],
      600_000,
    );
    expect(md).toContain('| 2.1 | Crawl | OK | run abc \\| 2482 pages · 125.0 s |');
    expect(md).toContain('**FAIL**');
    expect(md).not.toContain('sk_secret123');
    expect(md).toContain('Total wall time 10.0 min · 1 failed step(s)');
  });
});

describe('parseSimWeekGross', () => {
  it('reads the before / after week gross', () => {
    const line =
      'Week 2026-11-05 → 2026-11-12: 6721 SIM calls, $501.06 charged; SIM week gross $1,000.50 → $1,501.56 (target $1500.00)';
    expect(parseSimWeekGross(line)).toEqual({ before: 1000.5, after: 1501.56 });
    expect(parseSimWeekGross('nothing here')).toBeNull();
  });
});
