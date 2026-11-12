import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

export type ButtonVariant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm ' +
  'transition-[background-color,border-color,color,box-shadow] duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:pointer-events-none disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'label bg-accent text-on-accent hover:bg-accent-strong active:translate-y-px',
  dark: 'label bg-ink text-canvas hover:bg-ink/85 active:translate-y-px',
  secondary:
    'label border border-border bg-surface text-ink hover:border-muted/60 hover:bg-surface-2 active:translate-y-px',
  ghost: 'label text-body hover:bg-surface-2 hover:text-ink',
  danger:
    'label border border-border bg-surface text-danger hover:border-danger/40 hover:bg-danger-tint active:translate-y-px',
  link: 'font-medium text-accent underline-offset-4 hover:underline',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-2xs',
  md: 'h-8 px-3.5 text-xs',
  lg: 'h-10 px-4 text-[13px]',
};

const CHIP: Record<ButtonVariant, string> = {
  primary: 'bg-on-accent/20 text-on-accent',
  dark: 'bg-canvas/20 text-canvas',
  secondary: 'bg-surface-2 text-muted',
  ghost: 'bg-surface-2 text-muted',
  danger: 'bg-surface-2 text-muted',
  link: 'bg-surface-2 text-muted',
};

/** A keyboard-shortcut hint inside a button ("S", "P"). */
function ShortcutChip({ keys, variant = 'primary' }: { keys: string; variant?: ButtonVariant }) {
  return (
    <kbd
      aria-hidden="true"
      className={`-mr-1 rounded-xs px-1.5 py-px font-mono text-2xs font-normal normal-case ${CHIP[variant]}`}
    >
      {keys}
    </kbd>
  );
}

/**
 * Class string for a button-looking control, for when the element isn't `<Button>` (a `<Link>`,
 * an `<a download>`, a `<summary>`). `link` ignores size: it sits in running text.
 */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  className = '',
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  const sized = variant === 'link' ? 'text-sm' : SIZE[size];
  return `${BASE} ${VARIANT[variant]} ${sized} ${className}`.trim();
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (an icon from ./icons). */
  icon?: ReactNode;
  /**
   * Keyboard-shortcut hint shown in a chip after the label, e.g. "S". It also sets
   * `aria-keyshortcuts`, so pass it only when a key handler for it is actually installed.
   */
  shortcut?: string;
};

/** The one button. `type` defaults to "button" so it never submits a form by accident. */
export function Button({
  variant,
  size,
  icon,
  shortcut,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, className })}
      aria-keyshortcuts={shortcut}
      {...rest}
    >
      {icon}
      {children}
      {shortcut && <ShortcutChip keys={shortcut} variant={variant} />}
    </button>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({
  variant,
  size,
  icon,
  shortcut,
  className,
  children,
  ...rest
}: LinkProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  shortcut?: string;
}) {
  return (
    <Link
      className={buttonClass({ variant, size, className })}
      aria-keyshortcuts={shortcut}
      {...rest}
    >
      {icon}
      {children}
      {shortcut && <ShortcutChip keys={shortcut} variant={variant} />}
    </Link>
  );
}
