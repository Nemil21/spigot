import { Outlet, isRouteErrorResponse, useRouteError } from 'react-router';

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
    <div role="alert" className="mx-auto max-w-xl px-6 py-16">
      <div className="rounded-md border border-danger bg-danger-tint p-4 text-danger">
        <p className="font-medium">This page didn't load.</p>
        <p className="mt-1 text-sm">{message}</p>
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
