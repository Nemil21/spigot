import { ApiError } from '../api/client';
import { buttonClass } from './Button';
import { IconAlert, IconRetry } from './icons';

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
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-danger/25 bg-danger-tint px-4 py-3.5 sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <IconAlert className="mt-0.5 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-sm text-body">{errorMessage(error)}</p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={buttonClass({
            variant: 'secondary',
            size: 'sm',
            className: 'self-start sm:self-auto',
          })}
        >
          <IconRetry size={14} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
