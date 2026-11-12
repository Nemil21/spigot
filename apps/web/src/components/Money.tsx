import { MONEY_WORDS } from '@spigot/shared/copy';
import {
  centsToMicros,
  formatCents,
  formatCount,
  formatMicros,
  formatPer1000,
} from '@spigot/shared/money';
import { Skeleton } from './Skeleton';

export type MoneyWord = keyof typeof MONEY_WORDS;

type Amount =
  /** Ledger / per-call amount in integer micros. */
  | { micros: number; cents?: never }
  /** PayPal amount (top-ups, refunds, payouts) in integer cents. */
  | { cents: number; micros?: never };

export type MoneyProps = Amount & {
  /**
   * Append a money-copy-rule word from `@spigot/shared/copy`: `word="charged"` → "$0.0555
   * charged". Only use a word when its condition holds (screens.md money copy rule).
   */
  word?: MoneyWord;
  /** Show a per-unit price as a rate: `per1000="records"` → "$1.50 / 1,000 records". */
  per1000?: string;
  /** Skeleton instead of the number (never a spinner on money). */
  loading?: boolean;
  className?: string;
};

/**
 * One amount, in tabular figures so columns line up. The exact value in micros is in the tooltip,
 * so a rounded-looking cents amount can always be checked against the ledger. Amounts have no
 * spaces, so a narrow cell (a KPI tile at 1024 px) wraps only between the amount and its words.
 */
export function Money(props: MoneyProps) {
  const { word, per1000, loading, className = '' } = props;
  if (loading) return <Skeleton className="h-[1em] w-16" />;

  const micros = props.micros ?? centsToMicros(props.cents!);
  let text =
    per1000 !== undefined
      ? formatPer1000(micros, per1000)
      : props.cents !== undefined
        ? formatCents(props.cents)
        : formatMicros(micros);
  if (word) text += ` ${MONEY_WORDS[word]}`;
  const exact = per1000 !== undefined ? micros * 1000 : micros;

  return (
    <span
      className={`tabular-nums ${className}`}
      title={`${formatCount(exact)} micros`}
      data-micros={exact}
    >
      {text}
    </span>
  );
}
