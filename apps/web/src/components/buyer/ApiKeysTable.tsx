import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../ErrorBanner';
import * as ui from './ui';

/** `GET /api/buyer/keys` row (SP-007b): never the key, never its hash. */
export interface ApiKeyRow {
  id: string;
  name: string | null;
  prefix: string;
  scopes: ('read' | 'topup')[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** A key just created on this page: the only time its full value exists in the browser. */
export interface RevealedKey {
  id: string;
  key: string;
}

const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/**
 * API keys (W11): create (one-time reveal + copy), revoke. A revoked key fails its next `/v1` or
 * MCP call with `401 KEY_REVOKED`.
 */
export function ApiKeysTable({
  keys,
  revealed,
  onCreate,
  onRevoke,
  onDismissReveal,
}: {
  keys: ApiKeyRow[];
  revealed: RevealedKey | null;
  onCreate: (name: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onDismissReveal: () => void;
}) {
  const [name, setName] = useState('Claude Code');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim() || 'API key');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    setError(null);
    try {
      await onRevoke(id);
      setConfirming(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRevoking(null);
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      // Clipboard blocked: the key stays selectable.
    }
  }

  return (
    <section aria-labelledby="keys-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="keys-title" className={ui.panelTitle}>
            API keys
          </h2>
          <p className={ui.panelDesc}>
            Your agent sends one as{' '}
            <code className="font-mono text-xs text-body">Authorization: Bearer sk_spg_…</code>.
          </p>
        </div>
        <form onSubmit={create} className="flex w-full items-end gap-2 sm:w-auto">
          <label
            className="min-w-0 flex-1 text-xs font-medium text-muted sm:flex-none"
            htmlFor="key-name"
          >
            Key name
            <input
              id="key-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className={`${ui.input} sm:w-52`}
            />
          </label>
          <button type="submit" disabled={creating} className={ui.btnPrimary}>
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </form>
      </div>

      {(revealed || error) && (
        <div className="space-y-3 border-b border-line px-5 py-4 sm:px-6">
          {revealed && (
            <div role="status" className="rounded-lg border border-warning/40 bg-warning-tint p-4">
              <p className="text-sm font-medium text-warning">
                Copy this key now. We only show it once.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code
                  data-testid="revealed-key"
                  className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink select-all"
                >
                  {revealed.key}
                </code>
                <button
                  type="button"
                  onClick={() => copyKey(revealed.key)}
                  className={ui.btnSecondary}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </button>
                <button type="button" onClick={onDismissReveal} className={ui.btnGhost}>
                  I saved it
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className={ui.notice.danger}>
              {error}
            </p>
          )}
        </div>
      )}

      {keys.length === 0 ? (
        <p className={`${ui.panelBody} text-sm text-muted`}>
          No keys yet. Create one for your agent.
        </p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Name</th>
                <th className={ui.th}>Key</th>
                <th className={ui.th}>Scopes</th>
                <th className={ui.th}>Last used</th>
                <th className={ui.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  className={`${ui.tr} ${k.revokedAt ? 'text-muted' : ''}`}
                  data-revoked={k.revokedAt ? '' : undefined}
                >
                  <td className={`${ui.td} font-medium ${k.revokedAt ? 'text-muted' : 'text-ink'}`}>
                    {k.name ?? 'API key'}
                  </td>
                  <td className={ui.td}>
                    <code className="font-mono text-xs text-body">sk_spg_{k.prefix}…</code>
                  </td>
                  <td className={ui.td}>
                    <span className="flex gap-1">
                      {k.scopes.map((s, i) => (
                        <span key={s} className={ui.tag}>
                          {s}
                          {i < k.scopes.length - 1 && <span className="sr-only">,</span>}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={`${ui.td} whitespace-nowrap text-body tabular-nums`}>
                    {dateTime(k.lastUsedAt)}
                  </td>
                  <td className={`${ui.td} text-right`}>
                    {k.revokedAt ? (
                      <span className="whitespace-nowrap text-xs text-muted">
                        Revoked {dateTime(k.revokedAt)}
                      </span>
                    ) : confirming === k.id ? (
                      <span className="inline-flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => revoke(k.id)}
                          disabled={revoking === k.id}
                          className="inline-flex h-7 items-center rounded-md bg-danger px-2.5 text-xs font-medium text-on-accent disabled:opacity-60"
                        >
                          {revoking === k.id ? 'Revoking…' : 'Yes, revoke'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="inline-flex h-7 items-center rounded-md px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-ink"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(k.id)}
                        aria-label={`Revoke ${k.name ?? 'API key'} (sk_spg_${k.prefix}…)`}
                        className={ui.btnSmDanger}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
