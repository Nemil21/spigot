import { useEffect, useMemo, useRef, useState } from 'react';
import { api as defaultApi, type ApiClient } from '../../api/client';
import { ErrorBanner, SkeletonText } from '../../components';
import {
  ago,
  diffVersions,
  formatDateTime,
  formatValue,
  type DiffLine,
  type RecordHistory,
  type VersionDiff,
} from './model';

/**
 * W07 version drawer (screens.md §W07: "side drawer with version history (JSON Patch diff view)").
 * Lists a record's versions newest first; the selected one shows each changed field as
 * before → after (replayed from the stored patches) and, folded, the RFC 6902 patch as stored.
 * Hidden fields appear (it's the owner's data) and are marked "hidden": they were never sold.
 */
export function VersionDrawer({
  recordId,
  recordKey,
  client = defaultApi,
  onClose,
}: {
  recordId: string;
  recordKey: string;
  client?: ApiClient;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'ready'; history: RecordHistory }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: 'loading' });
    setSelected(null);
    client
      .get<RecordHistory>(`/api/records/${encodeURIComponent(recordId)}/versions`, {
        signal: ctl.signal,
      })
      .then(
        (history) => {
          if (!ctl.signal.aborted) setState({ status: 'ready', history });
        },
        (error: unknown) => {
          if (!ctl.signal.aborted) setState({ status: 'error', error });
        },
      );
    return () => ctl.abort();
  }, [client, recordId, attempt]);

  const diffs = useMemo(
    () =>
      state.status === 'ready'
        ? diffVersions(state.history.versions, state.history.hiddenFields)
        : [],
    [state],
  );
  const current = diffs.find((d) => d.version.seq === selected) ?? diffs[0];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/30" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-drawer-title"
        className="relative flex h-full w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-line bg-surface p-6 shadow-card"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="version-drawer-title" className="text-lg font-semibold text-ink">
              Version history
            </h2>
            <p className="mt-1 truncate font-mono text-xs text-muted" title={recordKey}>
              {recordKey}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-ink"
          >
            Close
          </button>
        </header>

        {state.status === 'loading' && (
          <div aria-busy="true">
            <SkeletonText lines={6} />
          </div>
        )}
        {state.status === 'error' && (
          <ErrorBanner error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
        )}
        {state.status === 'ready' && diffs.length === 0 && (
          <p className="text-sm text-body">
            No changes recorded in the last 30 days. This record is at version{' '}
            {state.history.record.version}.
          </p>
        )}
        {state.status === 'ready' && diffs.length > 0 && current && (
          <>
            <ol aria-label="Versions" className="flex flex-col gap-1">
              {diffs.map((d) => {
                const active = d === current;
                return (
                  <li key={d.version.seq}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelected(d.version.seq)}
                      className={`flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${
                        active ? 'bg-accent-tint text-ink' : 'text-body hover:bg-surface-2'
                      }`}
                    >
                      <span>
                        <span className="font-medium">v{d.version.version}</span>{' '}
                        <span>{OP_LABEL[d.version.op]}</span>
                        {d.version.op === 'update' && (
                          <span className="text-muted">
                            {' '}
                            · {d.lines.length} {d.lines.length === 1 ? 'field' : 'fields'}
                          </span>
                        )}
                      </span>
                      <time
                        dateTime={d.version.changedAt}
                        title={formatDateTime(d.version.changedAt)}
                        className="shrink-0 text-xs text-muted"
                      >
                        {ago(d.version.changedAt)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ol>
            {state.history.truncated && (
              <p className="text-xs text-muted">Showing the latest {diffs.length} versions.</p>
            )}
            <DiffView diff={current} />
          </>
        )}
      </aside>
    </div>
  );
}

const OP_LABEL = { add: 'added', update: 'updated', remove: 'removed' } as const;

function DiffView({ diff }: { diff: VersionDiff }) {
  const { version, lines } = diff;
  return (
    <section aria-label={`Changes in version ${version.version}`} className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink">
        Version {version.version}: {OP_LABEL[version.op]} {formatDateTime(version.changedAt)}
      </h3>
      {version.op === 'remove' ? (
        <p className="text-sm text-body">
          The record was removed from your site. Buyers got a remove change.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l) => (
              <DiffRow key={`${l.path}:${l.kind}`} line={l} beforeKnown={diff.beforeKnown} />
            ))}
          </tbody>
        </table>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-ink">
          JSON Patch (RFC 6902)
        </summary>
        <pre
          className="mt-2 max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-body"
          data-patch=""
        >
          {JSON.stringify(version.patch, null, 2)}
        </pre>
      </details>
    </section>
  );
}

function DiffRow({ line, beforeKnown }: { line: DiffLine; beforeKnown: boolean }) {
  const showBefore = line.kind !== 'added';
  return (
    <tr data-field={line.field} data-kind={line.kind} className="align-top">
      <td className="py-2 pr-3 font-mono text-xs text-ink">
        <span className={line.hidden ? 'line-through decoration-muted' : undefined}>
          {line.path.slice(1) || line.field}
        </span>
        {line.hidden && (
          <span
            className="ml-2 rounded-full bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] text-muted no-underline"
            title="Hidden: never sold to buyers"
          >
            hidden
          </span>
        )}
      </td>
      <td className="py-2 tabular-nums">
        {showBefore && (
          <del className="mr-2 text-danger" data-before="">
            {beforeKnown && line.before !== undefined ? formatValue(line.before) : '…'}
          </del>
        )}
        {line.kind !== 'removed' && (
          <ins className="text-positive no-underline" data-after="">
            {line.kind === 'added' ? '+ ' : '→ '}
            {formatValue(line.after)}
          </ins>
        )}
      </td>
    </tr>
  );
}
