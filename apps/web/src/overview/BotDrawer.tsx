import { formatCount } from '@spigot/shared/money';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Money, SimChip } from '../components';
import { paths } from '../routes';
import { CategoryBadge } from './CategoryBadge';
import { botLabel, categoryLabel, decisionLabel, formatBytes } from './labels';
import { Sparkline } from './Sparkline';
import { botRowId, type BotRow } from './types';

/**
 * W04 bot detail drawer: every row the report has for this bot (by decision and SIM), its 24 h
 * shape and what the site's policy does with its category. The gate stores counts per minute,
 * never paths or IP addresses (api.md §gate hits), so there are no sample paths to list.
 */
export function BotDrawer({
  bot,
  rows,
  policy,
  onClose,
}: {
  bot: BotRow;
  /** All rows currently in the report; the drawer picks this bot's. */
  rows: readonly BotRow[];
  policy: Record<string, unknown>;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus moves into the drawer and back to whatever opened it (the grid cell) on close.
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const mine = rows.filter((r) => r.botName === bot.botName && r.category === bot.category);
  const list = mine.length ? mine : [bot];
  const hits = list.reduce((a, r) => a + r.hits, 0);
  const paid = list.reduce((a, r) => a + r.wouldHavePaid, 0);
  const spark = list[0]!.hits24h.map((_, i) => list.reduce((a, r) => a + (r.hits24h[i] ?? 0), 0));
  const lastSeen = list
    .map((r) => r.lastSeen)
    .sort()
    .at(-1)!;
  const rule = policy[bot.category];
  const name = botLabel(bot.botName);

  return (
    <>
      <div className="fixed inset-0 z-30 bg-ink/20" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${name} details`}
        className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6 shadow-card"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{name}</h2>
            <p className="mt-1 flex items-center gap-2">
              <CategoryBadge category={bot.category} />
              {list.some((r) => r.isSimulated) && <SimChip />}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2"
          >
            Close
          </button>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted">Hits (7 d)</dt>
            <dd className="font-semibold text-ink tabular-nums">{formatCount(hits)}</dd>
          </div>
          <div>
            <dt className="text-muted">Last seen</dt>
            <dd className="text-ink">
              <time dateTime={lastSeen}>{new Date(lastSeen).toLocaleString()}</time>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Would have paid (est.)</dt>
            <dd className="italic text-ink">
              <Money micros={paid} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Your policy for {categoryLabel(bot.category)}</dt>
            <dd className="text-ink">
              {rule === 'QUOTE' ? 'Send to API' : rule === 'PASS' ? 'Pass' : 'Not set'}{' '}
              <Link className="text-accent underline" to={`${paths.settings}?tab=policy`}>
                Change
              </Link>
            </dd>
          </div>
        </dl>

        <h3 className="mt-6 text-sm font-semibold text-ink">Last 24 hours</h3>
        <div className="mt-2">
          <Sparkline points={spark} width={360} height={56} label={`${name}, hits per hour`} />
        </div>

        <h3 className="mt-6 text-sm font-semibold text-ink">Decisions</h3>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 font-medium">Decision</th>
              <th className="py-1 text-right font-medium">Hits</th>
              <th className="py-1 text-right font-medium">Bytes</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={botRowId(r)} className="border-t border-line">
                <td className="py-1.5">{decisionLabel(r.decision)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCount(r.hits)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatBytes(r.bytes)}</td>
                <td className="py-1.5 text-right">{r.isSimulated && <SimChip />}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-6 text-xs text-muted">
          Spigot's gate counts visits per minute. It never stores paths or IP addresses, so there
          are no sample pages to show.
        </p>
      </aside>
    </>
  );
}
