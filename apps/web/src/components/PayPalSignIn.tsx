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
      className={`mt-4 rounded-md px-3 py-2 text-sm ${
        m.ok ? 'bg-positive-tint text-positive' : 'bg-danger-tint text-danger'
      }`}
    >
      {m.text}
    </p>
  );
}

const buttonClass =
  'flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2 font-medium text-ink hover:bg-surface-2';

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
      <span aria-hidden="true" className="font-bold italic text-accent">
        P
      </span>
      {label}
    </a>
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
