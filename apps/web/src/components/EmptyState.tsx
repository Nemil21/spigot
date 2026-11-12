import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { buttonClass } from './Button';
import { IconInbox } from './icons';

type Action = { label: string } & (
  { to: string; onClick?: never } | { onClick: () => void; to?: never }
);

/**
 * Empty state (screens.md shared states): one short sentence and exactly one action. `title` and
 * `icon` are optional; the sentence carries the meaning on its own.
 */
export function EmptyState({
  message,
  action,
  title,
  icon,
}: {
  message: string;
  action: Action;
  title?: string;
  icon?: ReactNode;
}) {
  const cls = buttonClass({ variant: 'primary', className: 'mt-5' });
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-lg border border-line bg-surface-2 text-muted">
        {icon ?? <IconInbox size={18} />}
      </span>
      {title && <p className="mt-4 text-md font-semibold text-ink">{title}</p>}
      <p className={`${title ? 'mt-1' : 'mt-4'} max-w-md text-base text-body`}>{message}</p>
      {action.to !== undefined ? (
        <Link className={cls} to={action.to}>
          {action.label}
        </Link>
      ) : (
        <button type="button" className={cls} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
