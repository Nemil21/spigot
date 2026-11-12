import type { ReactNode } from 'react';

/**
 * The one accent word of a heading, in Instrument Serif italic and teal:
 * `<h2>Get paid <Accent>per record.</Accent></h2>`. One per heading, never in body copy or data.
 * The text stays part of the heading, so its accessible name is unchanged.
 */
export function Accent({ children }: { children: ReactNode }) {
  return (
    <span className="font-serif text-[1.08em] font-normal tracking-normal text-accent italic">
      {children}
    </span>
  );
}

/** A marker-tint band behind a few words (headings and the hero stat only). */
export function Marker({ children }: { children: ReactNode }) {
  return <span className="marker">{children}</span>;
}
