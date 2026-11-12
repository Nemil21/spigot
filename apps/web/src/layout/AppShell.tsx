import { useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { Logo } from '../components/Brand';
import type { NavItem } from '../routes';
import { setThemeMode, useThemeMode } from '../theme/mode';
import type { SessionState } from './session';

export interface AppShellProps<T extends { name: string; email: string }> {
  /** Accessible name of the nav landmark ("Publisher" / "Buyer"). */
  area: string;
  brand: string;
  nav: readonly NavItem[];
  session: SessionState<T> & { retry(): void };
  loginPath: string;
  logoutEndpoint: string;
  /** Extra line under the account name, e.g. "Demo account". */
  badge?: (session: T) => string | null;
}

/**
 * Left-nav shell shared by the publisher dashboard and the buyer portal. Pages render only once
 * the session is known, so they never fire API calls that would 401; signed-out visitors go to the
 * login page with `?next=` set to where they were.
 */
export function AppShell<T extends { name: string; email: string }>({
  area,
  brand,
  nav,
  session,
  loginPath,
  logoutEndpoint,
  badge,
}: AppShellProps<T>) {
  const location = useLocation();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  if (session.status === 'signedOut') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate replace to={`${loginPath}?next=${encodeURIComponent(next)}`} />;
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await api.post(logoutEndpoint);
    } finally {
      // Even if the call failed, leave the app; the login page is the safe place to land.
      navigate(loginPath, { replace: true });
    }
  }

  return (
    <div className="page-band flex min-h-screen bg-canvas text-body">
      <nav
        aria-label={area}
        className="sticky top-4 m-4 mr-0 flex h-[calc(100vh-2rem)] w-58 shrink-0 flex-col rounded-[20px] border border-white/8 bg-surface/80 p-3 pt-5 backdrop-blur-xl"
      >
        <p className="mb-6 px-2">
          <Logo suffix={brand === 'Spigot' ? undefined : 'for agents'} />
        </p>
        <p className="mb-2 px-3 text-[11px] font-medium tracking-[0.1em] text-muted uppercase">
          {area}
        </p>
        <ul className="space-y-0.5">
          {nav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-[10px] border px-3 py-2.5 text-sm ${isActive ? 'border-white/10 bg-white/8 font-medium text-ink [&>svg]:text-accent' : 'border-transparent text-body hover:bg-white/5 [&>svg]:opacity-60'}`
                }
              >
                <NavIcon label={item.label} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-3 rounded-[14px] border border-white/8 bg-white/4 p-3 text-sm">
          {session.status === 'ready' ? (
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid size-8.5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-sim text-xs font-semibold text-on-accent"
              >
                {initials(session.session.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{session.session.name}</p>
                <p className="truncate text-xs text-muted">{session.session.email}</p>
              </div>
            </div>
          ) : (
            <div aria-hidden="true">
              <Skeleton className="block h-4 w-28" />
              <Skeleton className="mt-1 block h-3 w-36" />
            </div>
          )}
          {session.status === 'ready' && badge?.(session.session) && (
            <p className="inline-block rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-medium text-accent">
              {badge(session.session)}
            </p>
          )}
          <div className="flex items-center justify-between border-t border-white/8 pt-3 text-xs">
            <ThemeToggle />
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut || session.status !== 'ready'}
              className="text-muted hover:text-ink disabled:opacity-60"
            >
              Log out
            </button>
          </div>
        </div>
      </nav>
      <main className="min-w-0 flex-1" aria-busy={session.status === 'loading' || undefined}>
        {session.status === 'ready' ? (
          <div key={location.pathname} className="page-in">
            <Outlet context={{ session: session.session }} />
          </div>
        ) : session.status === 'error' ? (
          <div className="mx-auto max-w-3xl px-6 py-10">
            <ErrorBanner
              title="We couldn't load your account."
              error={session.error}
              onRetry={session.retry}
            />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-10">
            <Skeleton className="block h-7 w-48" />
            <div className="mt-6">
              <SkeletonText lines={4} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ThemeToggle() {
  const mode = useThemeMode();
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setThemeMode(next)}
      aria-label={`Switch to ${next} theme`}
      className="block text-muted hover:text-ink"
    >
      {mode === 'dark' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}

function initials(name: string | null | undefined): string {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Line icons for the nav, keyed by label (Figma sidebar). Unknown labels get none. */
const ICON_PATHS: Record<string, string> = {
  Overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  'Record types': 'm12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  Records: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16',
  Earnings: 'm3 17 6-6 4 4 8-8M15 7h6v6',
  Payouts: 'M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v13H5a2 2 0 0 1-2-2V5',
  Crawls: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
  Settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1',
  'Balance and keys': 'M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v13H5a2 2 0 0 1-2-2V5',
  Usage: 'M22 12h-4l-3 9L9 3l-3 9H2',
};

function NavIcon({ label }: { label: string }) {
  const d = ICON_PATHS[label];
  if (!d) return null;
  return (
    <svg
      aria-hidden="true"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
