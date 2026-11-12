import {
  payoutStatusLabel,
  topupStatusLabel,
  type PayoutItemStatus,
  type TopupStatus,
} from '@spigot/shared/copy';

export type PillTone = 'positive' | 'info' | 'warning' | 'danger' | 'neutral';

export type StatusPillProps =
  { kind: 'payout'; status: PayoutItemStatus } | { kind: 'topup'; status: TopupStatus };

const PAYOUT_TONE: Record<PayoutItemStatus, PillTone> = {
  PENDING: 'info',
  SUCCESS: 'positive',
  UNCLAIMED: 'warning',
  FAILED: 'danger',
  RETURNED: 'danger',
};

const TOPUP_TONE: Record<TopupStatus, PillTone> = {
  CREATED: 'neutral',
  AWAITING_APPROVAL: 'info',
  COMPLETED: 'positive',
  FAILED: 'danger',
  ABANDONED: 'neutral',
  PARTIALLY_REFUNDED: 'warning',
  REFUNDED: 'neutral',
};

const TONE_CLASS: Record<PillTone, string> = {
  positive: 'bg-positive-tint text-positive',
  info: 'bg-info-tint text-info',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-surface-2 text-body',
};

const DOT_CLASS: Record<PillTone, string> = {
  positive: 'bg-positive',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-muted',
};

/** Payout item (W09) and top-up (W11) status, worded by `@spigot/shared/copy` only. */
export function StatusPill(props: StatusPillProps) {
  const [label, tone] =
    props.kind === 'payout'
      ? [payoutStatusLabel(props.status), PAYOUT_TONE[props.status]]
      : [topupStatusLabel(props.status), TOPUP_TONE[props.status]];
  return (
    <span
      className={`label inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-xs pr-1.5 pl-1.5 text-2xs ${TONE_CLASS[tone]}`}
      data-status={props.status}
      data-tone={tone}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT_CLASS[tone]}`} />
      {label}
    </span>
  );
}
