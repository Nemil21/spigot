import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../ErrorBanner';

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
    <section
      aria-labelledby="keys-title"
      className="rounded-lg border border-line bg-surface p-5 shadow-card"
    >
      <h2 id="keys-title" className="text-lg font-semibold text-ink">
        API keys
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your agent sends one as{' '}
        <code className="font-mono text-xs">Authorization: Bearer sk_spg_…</code>.
      </p>

      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-sm font-medium text-ink" htmlFor="key-name">
          Key name
          <input
            id="key-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-56 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-normal text-ink focus:outline-2 focus:outline-focus"
          />
        </label>
        <button
          type="submit"
          disabled={creating}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {revealed && (
        <div role="status" className="mt-4 rounded-md border border-warning bg-warning-tint p-3">
          <p className="text-sm font-medium text-warning">
            Copy this key now. We only show it once.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code
              data-testid="revealed-key"
              className="break-all font-mono text-sm text-ink select-all"
            >
              {revealed.key}
            </code>
            <button
              type="button"
              onClick={() => copyKey(revealed.key)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-ink hover:bg-surface-2"
            >
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button
              type="button"
              onClick={onDismissReveal}
              className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink"
            >
              I saved it
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {keys.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No keys yet. Create one for your agent.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Scopes</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  className="border-t border-line"
                  data-revoked={k.revokedAt ? '' : undefined}
                >
                  <td className="py-2 pr-4 text-ink">{k.name ?? 'API key'}</td>
                  <td className="py-2 pr-4">
                    <code className="font-mono text-xs text-body">sk_spg_{k.prefix}…</code>
                  </td>
                  <td className="py-2 pr-4 text-body">{k.scopes.join(', ')}</td>
                  <td className="py-2 pr-4 text-body">{dateTime(k.lastUsedAt)}</td>
                  <td className="py-2 text-right">
                    {k.revokedAt ? (
                      <span className="text-xs text-muted">Revoked {dateTime(k.revokedAt)}</span>
                    ) : confirming === k.id ? (
                      <span className="inline-flex gap-2">
                        <button
                          type="button"
                          onClick={() => revoke(k.id)}
                          disabled={revoking === k.id}
                          className="rounded-md bg-danger px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-60"
                        >
                          {revoking === k.id ? 'Revoking…' : 'Yes, revoke'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(k.id)}
                        aria-label={`Revoke ${k.name ?? 'API key'} (sk_spg_${k.prefix}…)`}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-danger hover:bg-danger-tint"
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
