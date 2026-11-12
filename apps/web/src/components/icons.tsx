import type { ReactNode, SVGProps } from 'react';

/**
 * The app's icon set: drawn on a 16 px grid, 1.5 px round strokes, `currentColor`. Decorative by
 * default (`aria-hidden`); a control that is only an icon carries its own `aria-label`.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function icon(paths: ReactNode) {
  return function Icon({ size = 16, className = '', ...rest }: IconProps) {
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`shrink-0 ${className}`}
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

/** The Spigot mark: a tap spout with a falling drop. Filled, so it reads at 16 px. */
export function SpigotMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={`shrink-0 ${className}`}
    >
      <rect width="20" height="20" rx="5" fill="currentColor" />
      <path
        d="M4.5 7.25h6.25a3 3 0 0 1 3 3v.5"
        fill="none"
        stroke="var(--sp-on-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M8 5.25v2" stroke="var(--sp-on-accent)" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M13.75 12.6c.9 1.1 1.35 1.9 1.35 2.45a1.35 1.35 0 0 1-2.7 0c0-.55.45-1.35 1.35-2.45Z"
        fill="var(--sp-on-accent)"
      />
    </svg>
  );
}

export const IconOverview = icon(
  <>
    <rect x="2" y="2" width="5" height="5" rx="1.25" />
    <rect x="9" y="2" width="5" height="5" rx="1.25" />
    <rect x="2" y="9" width="5" height="5" rx="1.25" />
    <rect x="9" y="9" width="5" height="5" rx="1.25" />
  </>,
);
export const IconRecords = icon(
  <>
    <path d="M8 2 14 5 8 8 2 5Z" />
    <path d="m2 8 6 3 6-3" />
    <path d="m2 11 6 3 6-3" />
  </>,
);
export const IconEarnings = icon(
  <>
    <path d="M2 14h12" />
    <path d="M4 11V8" />
    <path d="M8 11V4" />
    <path d="M12 11V6.5" />
  </>,
);
export const IconPayouts = icon(
  <>
    <rect x="1.75" y="3.5" width="12.5" height="9" rx="1.75" />
    <path d="M1.75 6.5h12.5" />
    <path d="M4.5 10h2" />
  </>,
);
export const IconCrawls = icon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.6 1.7 2.4 3.7 2.4 6S9.6 12.3 8 14C6.4 12.3 5.6 10.3 5.6 8S6.4 3.7 8 2Z" />
  </>,
);
export const IconSettings = icon(
  <>
    <path d="M2.5 4.5h6" />
    <path d="M11.5 4.5h2" />
    <circle cx="10" cy="4.5" r="1.5" />
    <path d="M2.5 11.5h2" />
    <path d="M7.5 11.5h6" />
    <circle cx="6" cy="11.5" r="1.5" />
  </>,
);
export const IconWallet = icon(
  <>
    <rect x="1.75" y="3.25" width="12.5" height="10" rx="1.75" />
    <path d="M14.25 6.5H11a1.75 1.75 0 0 0 0 3.5h3.25" />
  </>,
);
export const IconActivity = icon(<path d="M1.75 8.5h2.5l1.75-5 3.5 9 1.75-4h3" />);
export const IconShield = icon(
  <>
    <path d="M8 1.75 13.25 3.5v4.25c0 3.1-2.2 5.3-5.25 6.5-3.05-1.2-5.25-3.4-5.25-6.5V3.5Z" />
    <path d="m5.75 8 1.6 1.6 2.9-3.1" />
  </>,
);
export const IconSun = icon(
  <>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </>,
);
export const IconMoon = icon(<path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.5 4.5 0 0 0 7.1 7.1Z" />);
export const IconLogout = icon(
  <>
    <path d="M6 2.5H3.75c-.69 0-1.25.56-1.25 1.25v8.5c0 .69.56 1.25 1.25 1.25H6" />
    <path d="M10.5 11 13.5 8l-3-3" />
    <path d="M13.5 8H6" />
  </>,
);
export const IconMenu = icon(<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />);
export const IconClose = icon(<path d="m4 4 8 8M12 4l-8 8" />);
export const IconAlert = icon(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 5v3.5" />
    <circle cx="8" cy="10.9" r=".6" fill="currentColor" stroke="none" />
  </>,
);
export const IconRetry = icon(
  <>
    <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
    <path d="M13.25 2.5v3.25H10" />
  </>,
);
export const IconArrowRight = icon(<path d="M3 8h10M9 4l4 4-4 4" />);
export const IconCheck = icon(<path d="m3.5 8.5 3 3 6-6.5" />);
export const IconCopy = icon(
  <>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
    <path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25H3.5c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75" />
  </>,
);
export const IconInbox = icon(
  <>
    <path d="M2 9.25 3.6 3.6c.15-.5.6-.85 1.13-.85h6.54c.53 0 .98.35 1.13.85L14 9.25" />
    <path d="M2 9.25V12c0 .69.56 1.25 1.25 1.25h9.5c.69 0 1.25-.56 1.25-1.25V9.25h-3.5a2.5 2.5 0 0 1-5 0Z" />
  </>,
);
