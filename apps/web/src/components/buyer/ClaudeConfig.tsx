import { useEffect, useState } from 'react';

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
 * "Connect Claude Desktop" (W11). The full key is only in the browser right after it was created
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const key = revealedKey ?? (keyPrefix ? `sk_spg_${keyPrefix}…` : 'sk_spg_…');
  const snippet = claudeDesktopConfig(mcpUrl(origin), key);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      // Clipboard blocked: the snippet stays selectable.
    }
  }

  return (
    <section
      aria-labelledby="claude-title"
      className="rounded-lg border border-line bg-surface p-5 shadow-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="claude-title" className="text-lg font-semibold text-ink">
            Connect Claude Desktop
          </h2>
          <p className="mt-1 text-sm text-muted">
            Add this to <code className="font-mono text-xs">claude_desktop_config.json</code>, then
            restart Claude Desktop.
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          {copied ? 'Copied' : 'Copy config'}
        </button>
      </div>
      {!revealedKey && (
        <p className="mt-3 text-sm text-warning">
          Replace the key with the one you saved when you created it (we only show it once), or
          create a new key above.
        </p>
      )}
      <pre
        data-testid="claude-config"
        className="mt-3 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-ink select-all"
      >
        {snippet}
      </pre>
    </section>
  );
}
