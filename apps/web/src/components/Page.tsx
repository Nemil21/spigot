import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Page layout primitives. Inside a shell a screen is:
 *
 *   <Page>
 *     <PageHeader title="Earnings" description="…" actions={<Button>…</Button>} />
 *     <Section title="By dataset"> <Card>…</Card> </Section>
 *   </Page>
 *
 * `Page` owns the content width and gutters, so every screen lines up with every other.
 */

const WIDTH = {
  narrow: 'max-w-3xl',
  default: 'max-w-6xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
} as const;

export function Page({
  width = 'default',
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { width?: keyof typeof WIDTH }) {
  return (
    <div
      className={`mx-auto w-full ${WIDTH[width]} space-y-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The page's h1 with an optional one-line description, meta row and right-aligned actions. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className = '',
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Small row under the title: a status pill, "Updated 2 min ago", a SIM chip. */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-base text-muted">{description}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled group of content on a page (an h2 and what belongs under it). */
export function Section({
  title,
  description,
  actions,
  className = '',
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`space-y-3 ${className}`} {...rest}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-md font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A surface: hairline border, soft shadow, 10 px radius. `padded={false}` for a card that holds a
 * grid or a list edge to edge. Give it a `title` for a header row with a divider.
 */
export function Card({
  title,
  description,
  actions,
  padded = true,
  className = '',
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-line bg-surface shadow-card ${className}`}
      {...rest}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {padded ? <div className="p-5">{children}</div> : children}
    </div>
  );
}
