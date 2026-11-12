import { useEffect, useState, type ReactNode } from 'react';
import * as ui from './ui';

/** The MCP endpoint on this deployment (`/mcp` on the API, same origin as the portal). */
export function mcpUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/**
 * Claude Desktop's `claude_desktop_config.json` entry (features/11 §Logic 8): `mcp-remote` bridges
 * Claude Desktop to Spigot's Streamable HTTP MCP server with the buyer's key as a Bearer header.
 */
export function claudeDesktopConfig(url: string, key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        spigot: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${key}`],
        },
      },
    },
    null,
    2,
  );
}

/**
 * The Claude Code CLI command that adds Spigot as a remote (Streamable HTTP) MCP server with the
 * buyer's key as a Bearer header (docs/demo/claude-code-cli.md). Single-quoted so a shell never
 * expands anything in the key.
 */
export function claudeCodeCommand(url: string, key: string): string {
  return `claude mcp add --transport http spigot ${url} \\\n  --header 'Authorization: Bearer ${key}'`;
}

/** A copy button that says "Copied" for 1.5 s. Clipboard blocked: the text stays selectable. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard blocked: the snippet stays selectable.
    }
  }
  return (
    <button type="button" onClick={copy} className={ui.btnSmSecondary}>
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * "Connect your agent" (W11): the Claude Code command and the Claude Desktop config. The full key is only in the browser right after it was created
 * (it's never stored in clear); afterwards the snippet carries the key's prefix and a placeholder,
 * and the buyer pastes their saved key or creates a new one.
 */
export function ClaudeConfig({
  revealedKey,
  keyPrefix,
  origin,
}: {
  /** The key just created on this page, if any. */
  revealedKey: string | null;
  /** The newest active key's prefix, for the placeholder. */
  keyPrefix: string | null;
  origin?: string;
}) {
  const key = revealedKey ?? (keyPrefix ? `sk_spg_${keyPrefix}…` : 'sk_spg_…');
  const url = mcpUrl(origin);
  const command = claudeCodeCommand(url, key);
  const snippet = claudeDesktopConfig(url, key);

  return (
    <section aria-labelledby="claude-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="claude-title" className={ui.panelTitle}>
            Connect your agent
          </h2>
          <p className={ui.panelDesc}>
            Add Spigot's MCP server to Claude so your agent can query datasets and pay per record.
          </p>
        </div>
      </div>
      <div className={`${ui.panelBody} space-y-6`}>
        {!revealedKey && (
          <p className={ui.notice.warning}>
            Replace the key with the one you saved when you created it (we only show it once), or
            create a new key above.
          </p>
        )}

        <div>
          <h3 className="text-sm font-semibold text-ink">Claude Code</h3>
          <p className="mt-0.5 text-sm text-muted">
            Run this in a terminal, then check <code className="font-mono text-xs">/mcp</code> lists
            Spigot&apos;s tools.
          </p>
          <CodeBlock caption="Terminal" copy={<CopyButton text={command} label="Copy command" />}>
            <pre
              data-testid="claude-code-command"
              className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-ink select-all"
            >
              {command}
            </pre>
          </CodeBlock>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-ink">Claude Desktop</h3>
          <p className="mt-0.5 text-sm text-muted">
            Add this to <code className="font-mono text-xs">claude_desktop_config.json</code>, then
            restart Claude Desktop.
          </p>
          <CodeBlock
            caption="claude_desktop_config.json"
            copy={<CopyButton text={snippet} label="Copy config" />}
          >
            <pre
              data-testid="claude-config"
              className="max-h-80 overflow-auto p-4 font-mono text-xs leading-relaxed text-ink select-all"
            >
              {snippet}
            </pre>
          </CodeBlock>
        </div>
      </div>
    </section>
  );
}

function CodeBlock({
  caption,
  copy,
  children,
}: {
  caption: string;
  copy: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-sm border border-line bg-surface-2/60">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2">
        <span className={`truncate ${ui.monoMeta}`}>{caption}</span>
        {copy}
      </div>
      {children}
    </div>
  );
}
