import type { ReactNode } from 'react';

export type BadgeTone =
  'accent' | 'money' | 'positive' | 'warning' | 'danger' | 'info' | 'neutral' | 'dark';

const TONE: Record<BadgeTone, string> = {
  accent: 'bg-accent-tint text-accent-strong',
  money: 'bg-money-tint text-money',
  positive: 'bg-positive-tint text-positive',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  info: 'bg-info-tint text-info',
  neutral: 'border border-line bg-surface-2 text-body',
  dark: 'bg-ink text-canvas',
};

/** Small mono UPPERCASE chip ("LIVE", "JSON-LD", "PER RECORD"). For status use StatusPill. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`label inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-2xs ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
