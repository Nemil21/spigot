import { autoTopupCapReachedMessage, autoTopupDeclinedMessage } from '@spigot/shared/copy';
import { formatCents } from '@spigot/shared/money';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { ErrorBanner, SkeletonText } from '../../components';
import * as ui from '../../components/buyer/ui';

/** `GET` / `PUT /api/buyer/auto-topup` (SP-047b). */
export interface AutoTopupSettings {
  enabled: boolean;
  amountCents: number;
  thresholdMicros: number;
  monthlyCapCents: number;
  usedThisMonthCents: number;
  remainingThisMonthCents: number;
  savedMethod: { kind: 'CARD' | 'PAYPAL'; label: string } | null;
  capReached: boolean;
  declinedAt: string | null;
}

const MIN_CENTS = 500;
const MAX_CENTS = 50_000;
const MAX_CAP_CENTS = MAX_CENTS * 10;
const MICROS_PER_CENT = 10_000;

interface Form {
  enabled: boolean;
  amount: string;
  threshold: string;
  cap: string;
}

type FieldErrors = Partial<Record<'amount' | 'threshold' | 'cap', string>>;

/** "20", "$20", "20.5" → 2050 cents; anything else → null. */
export function dollarsToCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

const dollars = (cents: number) =>
  cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

function formOf(s: AutoTopupSettings): Form {
  return {
    enabled: s.enabled,
    amount: dollars(s.amountCents),
    threshold: dollars(Math.round(s.thresholdMicros / MICROS_PER_CENT)),
    cap: dollars(s.monthlyCapCents),
  };
}

function validate(f: Form): { errors: FieldErrors; body?: Record<string, unknown> } {
  const errors: FieldErrors = {};
  const amount = dollarsToCents(f.amount);
  const threshold = dollarsToCents(f.threshold);
  const cap = dollarsToCents(f.cap);
  if (amount === null || amount < MIN_CENTS || amount > MAX_CENTS) {
    errors.amount = `Enter an amount from ${formatCents(MIN_CENTS)} to ${formatCents(MAX_CENTS)}.`;
  }
  if (threshold === null || threshold > MAX_CENTS) {
    errors.threshold = `Enter a balance from $0 to ${formatCents(MAX_CENTS)}.`;
  }
  if (cap === null || cap > MAX_CAP_CENTS) {
    errors.cap = `Enter a cap up to ${formatCents(MAX_CAP_CENTS)}.`;
  } else if (amount !== null && cap < amount) {
    errors.cap = 'The monthly cap must be at least the top-up amount.';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    body: {
      enabled: f.enabled,
      amountCents: amount,
      thresholdMicros: threshold! * MICROS_PER_CENT,
      monthlyCapCents: cap,
    },
  };
}

const inputCls = `${ui.input} aria-invalid:border-danger`;

export interface AutoTopupCardProps {
  client: ApiClient;
  /** Bump to re-read the settings (a top-up just saved a method). */
  reloadToken?: number;
}

/**
 * W11 auto top-up card (screens.md §W11, §W15; SP-047b): "$20 when below $2, max $100/month",
 * the saved method, what is left of this month's cap, and the cap-reached and declined banners.
 * The agent's auto top-ups and MCP `top_up` from the saved method both count against the cap.
 */
export function AutoTopupCard({ client, reloadToken = 0 }: AutoTopupCardProps) {
  const [settings, setSettings] = useState<AutoTopupSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    client.get<AutoTopupSettings>('/api/buyer/auto-topup').then(
      (s) => {
        if (!live) return;
        setSettings(s);
        setForm(formOf(s));
      },
      (err: unknown) => live && setLoadError(err),
    );
    return () => {
      live = false;
    };
  }, [client, attempt, reloadToken]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || saving) return;
    const { errors, body } = validate(form);
    setFieldErrors(errors);
    setSaveError(null);
    setSaved(false);
    if (!body) return;
    setSaving(true);
    try {
      const s = await client.put<AutoTopupSettings>('/api/buyer/auto-topup', body);
      setSettings(s);
      setForm(formOf(s));
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="auto-topup-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div>
          <h2 id="auto-topup-title" className={ui.panelTitle}>
            Auto top-up
          </h2>
          {settings && form && loadError === null && (
            <p className={ui.panelDesc}>
              Your agent keeps working when its balance runs low: Spigot charges your saved method,
              never more than your monthly cap.
            </p>
          )}
        </div>
      </div>
      <div className={ui.panelBody}>
        {loadError !== null ? (
          <ErrorBanner error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !settings || !form ? (
          <div aria-busy="true">
            <SkeletonText lines={3} />
          </div>
        ) : (
          <>
            {settings.declinedAt && (
              <p role="alert" className={`mb-4 ${ui.notice.danger}`}>
                {autoTopupDeclinedMessage(
                  settings.savedMethod ? { method: settings.savedMethod.kind } : {},
                )}
              </p>
            )}
            {settings.capReached && (
              <p role="alert" className={`mb-4 ${ui.notice.warning}`}>
                {autoTopupCapReachedMessage({ monthlyCapCents: settings.monthlyCapCents })}
              </p>
            )}

            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">Saved method</dt>
                <dd className="mt-1 font-medium text-ink">
                  {settings.savedMethod ? (
                    settings.savedMethod.label
                  ) : (
                    <span className="font-normal text-body">
                      None yet. Top up once with “Save for auto top-up” ticked.
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">This month</dt>
                <dd className="mt-1 font-medium tabular-nums text-ink">
                  {formatCents(settings.remainingThisMonthCents)} left of{' '}
                  {formatCents(settings.monthlyCapCents)}
                </dd>
                <CapMeter
                  remaining={settings.remainingThisMonthCents}
                  cap={settings.monthlyCapCents}
                />
              </div>
            </dl>

            <form noValidate onSubmit={save} className="mt-5 space-y-4 border-t border-line pt-5">
              <label className={`${ui.checkboxLabel} font-medium text-ink`}>
                <input
                  className={ui.checkbox}
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => {
                    setSaved(false);
                    setForm({ ...form, enabled: e.target.checked });
                  }}
                />
                Top up automatically
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  id="auto-topup-amount"
                  label="Amount ($)"
                  value={form.amount}
                  error={fieldErrors.amount}
                  onChange={(v) => setForm({ ...form, amount: v })}
                />
                <Field
                  id="auto-topup-threshold"
                  label="When below ($)"
                  value={form.threshold}
                  error={fieldErrors.threshold}
                  onChange={(v) => setForm({ ...form, threshold: v })}
                />
                <Field
                  id="auto-topup-cap"
                  label="Monthly cap ($)"
                  value={form.cap}
                  error={fieldErrors.cap}
                  onChange={(v) => setForm({ ...form, cap: v })}
                />
              </div>
              {saveError !== null && (
                <ErrorBanner
                  error={saveError}
                  title={
                    saveError instanceof ApiError && saveError.code === 'NO_SAVED_METHOD'
                      ? 'Auto top-up needs a saved method.'
                      : 'Not saved.'
                  }
                />
              )}
              <div className="flex items-center gap-3">
                <button type="submit" disabled={saving} className={ui.btnPrimary}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {saved && (
                  <span role="status" className="text-sm text-positive">
                    Saved.
                  </span>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

/** How much of the monthly cap auto top-up has used. Decorative: the text above says it. */
function CapMeter({ remaining, cap }: { remaining: number; cap: number }) {
  const used = cap > 0 ? Math.min(1, Math.max(0, (cap - remaining) / cap)) : 0;
  return (
    <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div
        className={`h-full rounded-full ${used >= 1 ? 'bg-warning' : 'bg-accent'}`}
        style={{ width: `${used * 100}%` }}
      />
    </div>
  );
}

function Field({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className={ui.label}>
        {label}
      </label>
      <input
        id={id}
        inputMode="decimal"
        className={inputCls}
        value={value}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
