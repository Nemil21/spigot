import { ApiError } from '../api/client';

/** What to say for an error: the API's own message when it sent one, else a plain fallback. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}

/**
 * Inline error with retry (screens.md shared states: Error = inline banner with retry). The retry
 * button is shown only when `onRetry` is given.
 */
export function ErrorBanner({
  error,
  title = "This didn't load.",
  onRetry,
  retrying = false,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-tint p-4 text-danger">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm">{errorMessage(error)}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-60"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
