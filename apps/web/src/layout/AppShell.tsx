import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  IconActivity,
  IconClose,
  IconCrawls,
  IconEarnings,
  IconLogout,
  IconMenu,
  IconMoon,
  IconOverview,
  IconPayouts,
  IconRecords,
  IconSettings,
  IconShield,
  IconSun,
  IconWallet,
  SpigotMark,
  type IconProps,
} from '../components/icons';
import { Page } from '../components/Page';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { paths, type NavItem } from '../routes';
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

/** Nav icons by destination; anything unlisted gets the overview grid. */
const NAV_ICON: Record<string, ComponentType<IconProps>> = {
  [paths.overview]: IconOverview,
  [paths.recordTypes]: IconRecords,
  [paths.recordsBrowser]: IconRecords,
  [paths.earnings]: IconEarnings,
  [paths.payouts]: IconPayouts,
  [paths.crawls]: IconCrawls,
  [paths.settings]: IconSettings,
  [paths.adminAudit]: IconShield,
  [paths.buyerPortal]: IconWallet,
  [paths.buyerUsage]: IconActivity,
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/**
 * Left-nav shell shared by the publisher dashboard and the buyer portal. Pages render only once
 * the session is known, so they never fire API calls that would 401; signed-out visitors go to the
 * login page with `?next=` set to where they were.
 *
 * ≥ 1024 px: a fixed sidebar. Below that: a top bar whose menu button opens the same nav.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();

  const menuButton = useRef<HTMLButtonElement>(null);

  // A nav click on a phone closes the menu.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Escape closes the open menu and puts focus back on its toggle.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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

  const badgeText = session.status === 'ready' ? (badge?.(session.session) ?? null) : null;

  return (
    <div className="min-h-screen bg-canvas text-body lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ink focus:shadow-overlay"
      >
        Skip to content
      </a>
      <nav
        aria-label={area}
        className="sticky top-0 z-30 flex flex-col border-b border-line bg-surface lg:h-screen lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0"
      >
        <div className="flex h-14 items-center justify-between gap-2 px-4 lg:px-4">
          <Link
            to={nav[0]?.to ?? '/'}
            className="flex min-w-0 items-center gap-2.5 rounded-md text-md font-semibold tracking-tight text-ink"
          >
            <SpigotMark size={22} className="text-accent" />
            <span className="truncate">{brand}</span>
          </Link>
          <button
            ref={menuButton}
            type="button"
            className="grid size-8 place-items-center rounded-md text-body hover:bg-surface-2 hover:text-ink lg:hidden"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
          </button>
        </div>

        <div
          id={menuId}
          className={`${menuOpen ? 'flex' : 'hidden'} max-h-[calc(100vh-3.5rem)] flex-1 flex-col overflow-y-auto border-t border-line lg:flex lg:max-h-none lg:border-t-0`}
        >
          <ul className="space-y-0.5 px-2 py-3 lg:py-2">
            {nav.map((item) => {
              const Icon = NAV_ICON[item.to] ?? IconOverview;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150 ${
                        isActive
                          ? 'bg-surface-2 font-medium text-ink'
                          : 'text-body hover:bg-surface-2/70 hover:text-ink'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          className={isActive ? 'text-accent' : 'text-muted group-hover:text-body'}
                        />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>

          <div className="mt-auto border-t border-line p-3">
            {session.status === 'ready' ? (
              <div className="flex min-w-0 items-center gap-2.5 px-1">
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-tint text-xs font-semibold text-accent-strong"
                >
                  {initials(session.session.name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{session.session.name}</p>
                  <p className="truncate text-xs text-muted">{session.session.email}</p>
                </div>
              </div>
            ) : (
              <div aria-hidden="true" className="flex items-center gap-2.5 px-1">
                <Skeleton className="size-8 rounded-full" />
                <span className="block">
                  <Skeleton className="block h-3.5 w-28" />
                  <Skeleton className="mt-1.5 block h-3 w-36" />
                </span>
              </div>
            )}
            {badgeText && (
              <p className="mt-2.5 ml-1 inline-flex h-5 items-center rounded-full border border-border px-2 text-2xs font-medium text-muted">
                {badgeText}
              </p>
            )}
            <div className="mt-3 flex items-center gap-1">
              <ThemeToggle />
              <button
                type="button"
                onClick={logout}
                disabled={loggingOut || session.status !== 'ready'}
                className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-sm text-body transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-55"
              >
                <IconLogout className="text-muted" />
                Log out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main
        id="main"
        tabIndex={-1}
        className="min-w-0 flex-1 outline-none"
        aria-busy={session.status === 'loading' || undefined}
      >
        {session.status === 'ready' ? (
          <Outlet context={{ session: session.session }} />
        ) : session.status === 'error' ? (
          <Page width="narrow">
            <ErrorBanner
              title="We couldn't load your account."
              error={session.error}
              onRetry={session.retry}
            />
          </Page>
        ) : (
          <Page>
            <div>
              <Skeleton className="block h-7 w-48" />
              <Skeleton className="mt-3 block h-4 w-80 max-w-full" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="block h-[88px] w-full rounded-lg" />
              ))}
            </div>
            <div className="rounded-lg border border-line bg-surface p-5">
              <SkeletonText lines={5} />
            </div>
          </Page>
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
      title={`Switch to ${next} theme`}
      className="grid size-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {mode === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}
