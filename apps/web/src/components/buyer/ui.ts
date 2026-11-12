/**
 * Class vocabulary for the buyer area (W11, W12): one panel shape, one table rhythm, one button
 * set, so every buyer surface lines up. Semantic tokens only (theme/tokens.css).
 */

/** A panel: header row (title, description, actions) over a body or an edge-to-edge table. */
export const panel = 'overflow-hidden rounded-xl border border-line bg-surface shadow-card';
export const panelHead =
  'flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-4 sm:px-6';
export const panelTitle = 'text-[15px] font-semibold leading-6 text-ink';
export const panelDesc = 'mt-0.5 max-w-prose text-sm text-muted';
export const panelBody = 'px-5 py-5 sm:px-6';

/** Tables run edge to edge inside a panel; the first and last cells carry the panel padding. */
export const tableWrap = 'overflow-x-auto';
export const table = 'w-full text-left text-sm';
export const th =
  'whitespace-nowrap border-b border-line bg-surface-2/60 px-3 py-2.5 text-xs font-medium text-muted first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
export const td = 'px-3 py-3 align-middle first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
export const tr = 'border-t border-line first:border-t-0 transition-colors hover:bg-surface-2/40';

const btn =
  'inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';
export const btnPrimary = `${btn} bg-accent text-on-accent shadow-sm hover:bg-accent-strong`;
export const btnSecondary = `${btn} border border-border bg-surface text-ink hover:bg-surface-2`;
export const btnGhost = `${btn} text-muted hover:bg-surface-2 hover:text-ink`;
export const btnDanger = `${btn} bg-danger text-on-accent hover:opacity-90`;
/** Compact buttons for table rows. */
export const btnSmSecondary =
  'inline-flex h-7 items-center rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-60';
export const btnSmDanger =
  'inline-flex h-7 items-center rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-danger transition-colors hover:border-danger hover:bg-danger-tint disabled:opacity-60';

export const label = 'block text-sm font-medium text-ink';
export const input =
  'mt-1.5 block h-9 w-full rounded-md border border-border bg-surface px-3 text-sm font-normal text-ink tabular-nums shadow-xs placeholder:text-muted hover:border-muted focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-focus';
export const checkboxLabel = 'flex items-center gap-2.5 text-sm text-body';
export const checkbox = 'size-4 rounded-sm accent-[var(--sp-accent)]';

/** Amount picker: a segmented control, the chosen amount raised. */
export const segmented = 'inline-flex rounded-lg border border-line bg-surface-2 p-1';
export const segment = (on: boolean) =>
  `min-w-16 rounded-md px-4 py-1.5 text-sm font-semibold tabular-nums transition-colors ${
    on ? 'bg-surface text-ink shadow-sm ring-1 ring-border' : 'text-muted hover:text-ink'
  }`;

/** Inline status lines (role="status" / "alert"), one tone per outcome. */
const note = 'rounded-lg px-3.5 py-2.5 text-sm';
export const notice = {
  neutral: `${note} bg-surface-2 text-body`,
  info: `${note} bg-info-tint text-info`,
  positive: `${note} bg-positive-tint text-positive`,
  warning: `${note} bg-warning-tint text-warning`,
  danger: `${note} bg-danger-tint text-danger`,
} as const;

/** Short code chips (triggers, channels). */
export const tag =
  'inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-body ring-1 ring-inset ring-line';
