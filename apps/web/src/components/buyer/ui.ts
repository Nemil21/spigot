/**
 * Class vocabulary for the buyer and ops areas (W11, W12, W14): one panel shape, one table rhythm,
 * one button set, so every surface lines up. Semantic tokens only (theme/tokens.css).
 *
 * The system: 1px hairlines instead of shadows, small radii, mono uppercase labels for buttons,
 * column headers and stat captions, medium-weight titles, and the accent colour for the one
 * action per surface.
 */

/** Mono uppercase caption: column headers, stat labels, buttons. */
export const caption = 'font-mono text-[11px] font-medium uppercase tracking-[0.06em]';
/** Mono caption that keeps its real case (file names, commands). */
export const monoMeta = 'font-mono text-[11px] font-medium text-muted';
/** One accent word in a page heading, set in the serif italic. */
export const accentWord = 'font-serif font-normal italic tracking-normal text-accent';
/** Page heading (h1) and its one-line purpose. */
export const pageTitle =
  'text-[28px] font-medium leading-tight tracking-[-0.03em] text-ink sm:text-[32px]';
export const pageLede = 'mt-2 max-w-2xl text-[15px] text-body';

/** A panel: header row (title, description, actions) over a body or an edge-to-edge table. */
export const panel = 'overflow-hidden rounded-md border border-line bg-surface';
export const panelHead =
  'flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-4 sm:px-6';
export const panelTitle = 'text-[17px] font-medium leading-6 tracking-[-0.015em] text-ink';
export const panelDesc = 'mt-0.5 max-w-prose text-sm text-muted';
export const panelBody = 'px-5 py-5 sm:px-6';

/** Tables run edge to edge inside a panel; the first and last cells carry the panel padding. */
export const tableWrap = 'overflow-x-auto';
export const table = 'w-full text-left text-sm';
export const th =
  'whitespace-nowrap border-b border-line px-3 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
export const td = 'px-3 py-3 align-middle first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';
export const tr = 'border-t border-line first:border-t-0 transition-colors hover:bg-surface-2/40';

const btn =
  'inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-sm px-4 font-mono text-[12px] font-medium uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-60';
export const btnPrimary = `${btn} bg-accent text-on-accent hover:bg-accent-strong`;
export const btnSecondary = `${btn} border border-border bg-surface text-ink hover:bg-surface-2`;
export const btnGhost = `${btn} text-muted hover:bg-surface-2 hover:text-ink`;
export const btnDanger = `${btn} bg-danger text-on-accent hover:opacity-90`;
/** Compact buttons for table rows. */
export const btnSmSecondary =
  'inline-flex h-7 items-center rounded-sm border border-border bg-surface px-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink transition-colors hover:bg-surface-2 disabled:opacity-60';
export const btnSmDanger =
  'inline-flex h-7 items-center rounded-sm border border-border bg-surface px-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-danger transition-colors hover:border-danger hover:bg-danger-tint disabled:opacity-60';

export const label = 'block text-sm font-medium text-ink';
/** Small mono label above a stat or field group. */
export const statLabel = `${caption} text-muted`;
export const input =
  'mt-1.5 block h-9 w-full rounded-sm border border-border bg-surface px-3 text-sm font-normal text-ink tabular-nums placeholder:text-muted hover:border-muted focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-focus';
export const checkboxLabel = 'flex items-center gap-2.5 text-sm text-body';
export const checkbox = 'size-4 rounded-sm accent-[var(--sp-accent)]';

/** Amount picker: a segmented control, the chosen amount raised. */
export const segmented = 'inline-flex rounded-sm border border-line bg-surface-2 p-0.5';
export const segment = (on: boolean) =>
  `min-w-16 rounded-[3px] px-4 py-1.5 text-sm font-semibold tabular-nums transition-colors ${
    on ? 'bg-surface text-ink ring-1 ring-border' : 'text-muted hover:text-ink'
  }`;

/** Inline status lines (role="status" / "alert"), one tone per outcome. */
const note = 'rounded-sm px-3.5 py-2.5 text-sm';
export const notice = {
  neutral: `${note} bg-surface-2 text-body`,
  info: `${note} bg-info-tint text-info`,
  positive: `${note} bg-positive-tint text-positive`,
  warning: `${note} bg-warning-tint text-warning`,
  danger: `${note} bg-danger-tint text-danger`,
} as const;

/** Short code chips (triggers, channels). */
export const tag =
  'inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-body ring-1 ring-inset ring-line';

/** Grids with up to this many rows size to their rows (no empty band); longer ones scroll. */
export const GRID_AUTO_HEIGHT_ROWS = 15;
