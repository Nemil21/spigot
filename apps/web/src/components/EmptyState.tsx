import { Link } from 'react-router';

type Action = { label: string } & (
  { to: string; onClick?: never } | { onClick: () => void; to?: never }
);

/** Empty state (screens.md shared states): one short sentence and exactly one action. */
export function EmptyState({ message, action }: { message: string; action: Action }) {
  const cls =
    'mt-4 inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-strong';
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center">
      <p className="text-body">{message}</p>
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
