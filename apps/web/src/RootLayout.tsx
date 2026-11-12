import { Outlet, isRouteErrorResponse, useRouteError } from 'react-router';
import { buttonClass } from './components/Button';
import { IconAlert, IconRetry } from './components/icons';

/** Top of the route tree: nothing visual yet, so shells and screens own their own chrome. */
export function RootLayout() {
  return <Outlet />;
}

/** Last-resort error view (e.g. a lazy chunk failed to load after a deploy). */
export function RouteError() {
  const err = useRouteError();
  const message = isRouteErrorResponse(err)
    ? `${err.status} ${err.statusText}`
    : err instanceof Error
      ? err.message
      : 'Something went wrong.';
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-16">
      <div role="alert" className="w-full max-w-md text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-lg border border-danger/25 bg-danger-tint text-danger">
          <IconAlert size={18} />
        </span>
        <p className="mt-5 text-xl font-semibold text-ink">This page didn't load.</p>
        <p className="mt-2 text-base break-words text-muted">{message}</p>
        <div className="mt-7 flex justify-center gap-2">
          <button type="button" className={buttonClass()} onClick={() => window.location.reload()}>
            <IconRetry size={14} />
            Retry
          </button>
          <a href="/" className={buttonClass({ variant: 'secondary' })}>
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
