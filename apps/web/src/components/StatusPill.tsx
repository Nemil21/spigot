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

/** Payout item (W09) and top-up (W11) status, worded by `@spigot/shared/copy` only. */
export function StatusPill(props: StatusPillProps) {
  const [label, tone] =
    props.kind === 'payout'
      ? [payoutStatusLabel(props.status), PAYOUT_TONE[props.status]]
      : [topupStatusLabel(props.status), TOPUP_TONE[props.status]];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
      data-status={props.status}
      data-tone={tone}
    >
      {label}
    </span>
  );
}
