// Pure helpers for `npm run demo:dry-run` (SP-039b). The CLI is `./demo-dry-run.ts`.
//
// The buyer agent in the demo is Claude Code CLI (`claude -p`) with Spigot's `/mcp` server added
// over HTTP. These helpers build its MCP config, read its `--output-format stream-json` transcript
// (which tools it called, in what order) and judge the run against the prompt card's rules:
// `quote` before `search_records`, and no hidden field (`agent_phone`) anywhere in the output.

/** The prompt card, verbatim (docs/demo/prompt-card.md). */
export const PROMPT_CARD =
  'Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed ' +
  'today. Quote first, then fetch.';

/** The MCP server name used in `claude mcp add` and in the generated config. */
export const MCP_SERVER_NAME = 'spigot';

/** Spigot tools Claude may call without a prompt. `top_up` is left out: it needs a person. */
export const ALLOWED_TOOLS = [
  'list_datasets',
  'describe_dataset',
  'quote',
  'search_records',
  'get_changes',
  'get_balance',
].map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

/** Claude Code's own tool for loading deferred MCP tool schemas: expected, not a problem. */
export const HARMLESS_BUILTIN_TOOLS = ['ToolSearch'];

/** Fields the demo hides in W06; any of them in the agent's output is a failed take. */
export const HIDDEN_FIELDS = ['agent_phone'];

/** `claude --mcp-config` JSON for Spigot's HTTP MCP server. Contains the key: write it 0600. */
export function mcpConfig(apiBase: string, apiKey: string) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `${apiBase.replace(/\/+$/, '')}/mcp`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };
}

/** Hide every Spigot key-shaped token (`sk_…`, `gk_…`, `ck_…`) and Bearer values in a string. */
export function redact(s: string): string {
  return s
    .replace(/\b((?:sk|gk|ck|spk)_)[A-Za-z0-9_-]{4,}/g, '$1…')
    .replace(/(Bearer\s+)\S+/gi, '$1…');
}

export interface AgentTranscript {
  /** Spigot tool names in call order, without the `mcp__spigot__` prefix. */
  tools: string[];
  /** Other tools the agent tried (should be none). */
  otherTools: string[];
  /** Concatenated text of every tool result. */
  toolResultText: string;
  /** The agent's final reply (`result` event), or '' if it never finished. */
  finalText: string;
  isError: boolean;
  costUsd: number | null;
  numTurns: number | null;
}

type Json = Record<string, unknown>;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

/**
 * Read `claude -p --output-format stream-json --verbose` output (one JSON event per line).
 * Lines that aren't JSON are ignored, so stray stderr in the stream does no harm.
 */
export function parseClaudeStream(stream: string): AgentTranscript {
  const out: AgentTranscript = {
    tools: [],
    otherTools: [],
    toolResultText: '',
    finalText: '',
    isError: false,
    costUsd: null,
    numTurns: null,
  };
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  for (const line of stream.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: Json;
    try {
      ev = JSON.parse(trimmed) as Json;
    } catch {
      continue;
    }
    const message = isObj(ev.message) ? ev.message : undefined;
    if (ev.type === 'assistant' && message) {
      for (const c of asArray(message.content)) {
        if (!isObj(c) || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
        if (c.name.startsWith(prefix)) out.tools.push(c.name.slice(prefix.length));
        else if (!HARMLESS_BUILTIN_TOOLS.includes(c.name)) out.otherTools.push(c.name);
      }
    } else if (ev.type === 'user' && message) {
      for (const c of asArray(message.content)) {
        if (isObj(c) && c.type === 'tool_result') out.toolResultText += `${textOf(c.content)}\n`;
      }
    } else if (ev.type === 'result') {
      out.finalText = typeof ev.result === 'string' ? ev.result : '';
      out.isError =
        ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
      out.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      out.numTurns = typeof ev.num_turns === 'number' ? ev.num_turns : null;
    }
  }
  return out;
}

export interface AgentVerdict {
  ok: boolean;
  /** Why the take must be redone; empty when `ok`. */
  problems: string[];
}

/** Judge a take by the prompt card's rules (features/12 §Edge cases: re-take if it skips `quote`). */
export function judgeAgentRun(t: AgentTranscript): AgentVerdict {
  const problems: string[] = [];
  const firstQuote = t.tools.indexOf('quote');
  const firstPaid = t.tools.findIndex((n) => n === 'search_records' || n === 'get_changes');
  if (firstPaid === -1) problems.push('never called search_records / get_changes');
  if (firstQuote === -1) problems.push('never called quote');
  else if (firstPaid !== -1 && firstQuote > firstPaid) problems.push('fetched before quoting');
  if (t.isError) problems.push('the agent run ended in an error');
  if (t.otherTools.length) problems.push(`called non-Spigot tools: ${t.otherTools.join(', ')}`);
  const everything = `${t.toolResultText}\n${t.finalText}`;
  for (const f of HIDDEN_FIELDS)
    if (everything.includes(f)) problems.push(`hidden field ${f} leaked`);
  return { ok: problems.length === 0, problems };
}

/** `$0.0555`-style dollars from micros (1 USD = 1,000,000 micros), 4 decimals under $1. */
export function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${Math.abs(dollars) < 1 && dollars !== 0 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}

/** `sim:buyers`' summary "SIM week gross $0.00 → $501.06" as dollars, or null if absent. */
export function parseSimWeekGross(line: string): { before: number; after: number } | null {
  const m = /SIM week gross \$([\d,.]+) → \$([\d,.]+)/.exec(line);
  if (!m) return null;
  const num = (v: string) => Number(v.replace(/,/g, ''));
  return { before: num(m[1]!), after: num(m[2]!) };
}

export interface StepResult {
  /** Checklist row, e.g. "2.1". */
  row: string;
  name: string;
  ok: boolean;
  /** Ids, counts and timings for the checklist's last column. Never secrets. */
  detail: string;
  ms: number;
}

/** The run report: one table row per step, ready to paste into docs/demo/dry-run-checklist.md. */
export function reportMarkdown(title: string, steps: StepResult[], totalMs: number): string {
  const cell = (s: string) => redact(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `### ${title}`,
    '',
    '| Row | Step | Result | Ids / timing |',
    '|---|---|---|---|',
    ...steps.map(
      (s) =>
        `| ${s.row} | ${cell(s.name)} | ${s.ok ? 'OK' : '**FAIL**'} | ${cell(s.detail)} · ${(s.ms / 1000).toFixed(1)} s |`,
    ),
    '',
    `Total wall time ${(totalMs / 1000 / 60).toFixed(1)} min · ${steps.filter((s) => !s.ok).length} failed step(s)`,
  ];
  return lines.join('\n');
}
