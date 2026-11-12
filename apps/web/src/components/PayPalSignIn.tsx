/**
 * Log in with PayPal (SP-058; screens.md §W02, §W16). The button is a plain link to
 * `GET /api/auth/paypal/start`: a full-page navigation, because the API answers with a 302 to
 * PayPal's consent page and PayPal comes back to `/api/auth/paypal/callback`, which redirects into
 * the app with `?paypal=<reason>` on anything but a plain sign-in.
 */

export const PAYPAL_START = '/api/auth/paypal/start';
/** W16: link PayPal to the signed-in publisher. A plain `PAYPAL_START` is always a login. */
export const PAYPAL_CONNECT = `${PAYPAL_START}?intent=connect`;

export type PayPalReason =
  'connected' | 'cancelled' | 'state' | 'unverified' | 'link-required' | 'taken' | 'error';

export const PAYPAL_MESSAGES: Record<PayPalReason, string> = {
  connected: 'PayPal connected. Your payouts now go to your PayPal account’s email.',
  cancelled: 'PayPal sign-in was cancelled.',
  state: 'That PayPal sign-in expired or didn’t match this browser. Try again.',
  unverified:
    'Your PayPal account needs a confirmed email address. Confirm it with PayPal, then try again.',
  'link-required':
    'A Spigot account already uses this PayPal email. Log in with your password, then connect PayPal from Settings → Payout.',
  taken: 'That PayPal account is already connected to another Spigot account.',
  error: 'PayPal sign-in didn’t work. Try again in a minute.',
};

/** The message for a `?paypal=` value, or null for none / an unknown value. */
export function paypalMessage(reason: string | null): { text: string; ok: boolean } | null {
  if (!reason || !Object.hasOwn(PAYPAL_MESSAGES, reason)) return null;
  return { text: PAYPAL_MESSAGES[reason as PayPalReason], ok: reason === 'connected' };
}

export function PayPalNotice({ reason }: { reason: string | null }) {
  const m = paypalMessage(reason);
  if (!m) return null;
  return (
    <p
      role={m.ok ? 'status' : 'alert'}
      className={`mt-4 rounded-md border px-3 py-2.5 text-sm text-ink ${
        m.ok ? 'border-positive/25 bg-positive-tint' : 'border-danger/25 bg-danger-tint'
      }`}
    >
      {m.text}
    </p>
  );
}

const buttonClass =
  'flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-base font-medium text-ink shadow-card transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export function PayPalButton({
  label,
  href = PAYPAL_START,
  className = '',
}: {
  label: string;
  href?: string;
  className?: string;
}) {
  return (
    <a href={href} className={`${buttonClass} ${className}`}>
      <PayPalGlyph />
      {label}
    </a>
  );
}

/** PayPal's double-P monogram, drawn in its brand blues. */
function PayPalGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="16" viewBox="0 0 14 16" className="shrink-0">
      <path
        d="M11.6 1.4C10.9.6 9.6.2 7.9.2H3.2c-.3 0-.6.2-.7.6L.6 12.9c0 .2.1.4.4.4h2.9l.7-4.6v.1c.1-.3.4-.6.7-.6h1.4c2.7 0 4.8-1.1 5.4-4.3V3.6c.2-1 0-1.6-.5-2.2"
        fill="#003087"
      />
      <path
        d="M12.1 3.7c-.6 3.2-2.7 4.3-5.4 4.3H5.3c-.3 0-.6.3-.7.6l-.9 5.9-.3 1.7c0 .2.1.4.3.4h2.4c.3 0 .6-.2.6-.5v-.1l.5-3v-.2c0-.3.3-.5.6-.5h.4c2.4 0 4.2-1 4.7-3.8.2-1.2.1-2.1-.5-2.8-.2-.2-.4-.3-.6-.5"
        fill="#0070e0"
      />
    </svg>
  );
}

/** "or" divider + the PayPal button, for the bottom of a login / sign-up card. */
export function PayPalAlternative({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <PayPalButton label={label} className="mt-4" />
      {hint && <p className="mt-2 text-center text-xs text-muted">{hint}</p>}
    </div>
  );
}
