import type { ReactNode } from 'react';
import type { PillTone } from '../../components';

const TONE_CLASS: Record<PillTone, string> = {
  positive: 'bg-positive-tint text-positive',
  info: 'bg-info-tint text-info',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-surface-2 text-body',
};

/** Claim / refund status pill (W12, W08 claims tab); same tones as the shared `StatusPill`. */
export function Pill({
  tone,
  status,
  children,
}: {
  tone: PillTone;
  status: string;
  children: ReactNode;
}) {
  return (
    <span
      data-status={status}
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}
