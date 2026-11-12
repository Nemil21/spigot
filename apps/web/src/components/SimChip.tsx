/**
 * Grey "SIM" chip on every simulated row (features/15: W04, W08, W09 statements, W14). A SIM
 * top-up that fell back to ledger-only (no PayPal order) reads "SIM (no PayPal)".
 */
export function SimChip({ noPayPal = false }: { noPayPal?: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-sm border border-border bg-surface-2 px-1.5 py-px text-[11px] font-semibold tracking-wide text-muted"
      title={
        noPayPal ? 'Simulated demo data, recorded without a PayPal payment' : 'Simulated demo data'
      }
    >
      {noPayPal ? 'SIM (no PayPal)' : 'SIM'}
    </span>
  );
}
