import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium ' +
  'transition-[background-color,border-color,color,box-shadow] duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:pointer-events-none disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent shadow-card hover:bg-accent-strong active:translate-y-px',
  secondary:
    'border border-border bg-surface text-ink shadow-card hover:border-muted/50 hover:bg-surface-2 active:translate-y-px',
  ghost: 'text-body hover:bg-surface-2 hover:text-ink',
  danger:
    'border border-border bg-surface text-danger shadow-card hover:border-danger/40 hover:bg-danger-tint active:translate-y-px',
  link: 'text-accent underline-offset-4 hover:underline',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-sm',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-4 text-base',
};

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
};

/** The one button. `type` defaults to "button" so it never submits a form by accident. */
export function Button({
  variant,
  size,
  icon,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({
  variant,
  size,
  icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClass({ variant, size, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
