import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { PillTone } from '../../components';
import { AuthBackdrop, Logo } from '../../components/Brand';

/**
 * Building blocks shared by the onboarding screens (W02 sign up + connect, W03 install + verify;
 * SP-026). Local to `pages/onboarding/` so no shared component file is edited.
 */

// ---------------------------------------------------------------------------------------------
// One-time site keys

export interface SiteKeys {
  gateKey: string;
  crawlKey: string;
}

/**
 * The gate and crawl keys from `POST /api/sites`, held in memory only (never storage, never
 * history state) so they are shown once: W03 reads them after connect, and a reload, or coming
 * back to W03 later, finds nothing and points to Settings to rotate them.
 */
const oneTimeKeys = new Map<string, SiteKeys>();

export function rememberSiteKeys(siteId: string, keys: SiteKeys): void {
  oneTimeKeys.set(siteId, keys);
}

export function peekSiteKeys(siteId: string): SiteKeys | null {
  return oneTimeKeys.get(siteId) ?? null;
}

export function forgetSiteKeys(siteId: string): void {
  oneTimeKeys.delete(siteId);
}

// ---------------------------------------------------------------------------------------------
// Layout

export function OnboardingLayout({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <AuthBackdrop>
      <div className={`mx-auto w-full ${wide ? 'max-w-3xl' : 'max-w-md'}`}>
        <p className="mb-6 flex justify-center">
          <Logo />
        </p>
        {children}
      </div>
    </AuthBackdrop>
  );
}

export const cardClass =
  'rounded-[22px] border border-white/10 bg-surface/85 p-8 shadow-card backdrop-blur-xl';
export const primaryButton =
  'rounded-md bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60';
export const secondaryButton =
  'rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60';

export function TextField({
  id,
  label,
  hint,
  error,
  ...input
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
} & InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="mt-4">
      <label className="block text-sm font-medium text-ink" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-ink focus:outline-2 focus:outline-focus"
        {...input}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pills and copy

const TONE_CLASS: Record<PillTone, string> = {
  positive: 'bg-positive-tint text-positive',
  info: 'bg-info-tint text-info',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-surface-2 text-body',
};

export function Pill({
  tone,
  children,
  label,
}: {
  tone: PillTone;
  children: ReactNode;
  label?: string;
}) {
  return (
    <span
      aria-label={label}
      data-tone={tone}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/** Copy `text` to the clipboard; the label flips to "Copied" for 2 s. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      // No clipboard (insecure context): the text is on screen to select by hand.
    }
  }
  return (
    <button type="button" onClick={copy} aria-label={label} className={secondaryButton}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A monospace block with a copy button. */
export function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md bg-surface-2 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-sm text-ink">
        {code}
      </pre>
      <CopyButton text={code} label={copyLabel} />
    </div>
  );
}

/** "4 s ago", "3 min ago", "2 h ago", "5 d ago". */
export function ago(fromIso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
