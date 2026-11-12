import { useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import { Skeleton, SkeletonText } from '../components/Skeleton';
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
    <div className="flex min-h-screen bg-canvas text-body">
      <nav
        aria-label={area}
        className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface p-4"
      >
        <p className="mb-6 px-3 text-lg font-semibold text-accent">{brand}</p>
        <ul className="space-y-1">
          {nav.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-accent-tint font-medium text-accent-strong' : 'text-body hover:bg-surface-2'}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-3 border-t border-line px-3 pt-4 text-sm">
          {session.status === 'ready' ? (
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{session.session.name}</p>
              <p className="truncate text-xs text-muted">{session.session.email}</p>
              {badge?.(session.session) && (
                <p className="mt-1 text-xs text-muted">{badge(session.session)}</p>
              )}
            </div>
          ) : (
            <div aria-hidden="true">
              <Skeleton className="block h-4 w-28" />
              <Skeleton className="mt-1 block h-3 w-36" />
            </div>
          )}
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
      </nav>
      <main className="min-w-0 flex-1" aria-busy={session.status === 'loading' || undefined}>
        {session.status === 'ready' ? (
          <Outlet context={{ session: session.session }} />
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
