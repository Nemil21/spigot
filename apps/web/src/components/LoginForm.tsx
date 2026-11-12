import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { buttonClass } from './Button';
import { errorMessage } from './ErrorBanner';
import { inputClass } from './Field';
import { IconAlert, SpigotMark } from './icons';

export interface LoginFormProps {
  /** `/api/auth/login` (publishers) or `/api/buyer/login` (buyers), SP-007a. */
  endpoint: string;
  /** Where to go after login: `/app` or `/buyers`. A `?next=` inside the same area wins. */
  home: string;
  title: string;
  subtitle: string;
  signUp: { to: string; label: string };
  /** Another way in, under the submit button (publishers: Log in with PayPal, SP-058). */
  alternative?: ReactNode;
  client?: ApiClient;
}

/**
 * `?next=` is honoured only for a same-origin path inside this area (`/app…` for publishers,
 * `/buyers…` for buyers), so a crafted link can't send someone off-site after they log in.
 */
export function safeNext(next: string | null, home: string): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return home;
  const path = next.split(/[?#]/, 1)[0]!;
  return path === home || path.startsWith(`${home}/`) ? next : home;
}

/** Email + password form shared by the publisher and buyer login pages (features/14 §Auth). */
export function LoginForm({
  endpoint,
  home,
  title,
  subtitle,
  signUp,
  alternative,
  client = defaultApi,
}: LoginFormProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.post(endpoint, { email: email.trim(), password });
      navigate(safeNext(params.get('next'), home), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'VALIDATION_ERROR'
          ? 'Enter your email and password.'
          : errorMessage(err),
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center bg-canvas px-4 py-10 sm:justify-center sm:py-16">
      <div className="w-full max-w-[380px]">
        <Link
          to="/"
          className="mx-auto mb-8 flex w-fit items-center gap-2 rounded-md text-md font-semibold tracking-tight text-ink"
        >
          <SpigotMark size={24} className="text-accent" />
          Spigot
        </Link>
        <form
          onSubmit={onSubmit}
          noValidate
          className="rounded-xl border border-line bg-surface p-6 shadow-raised sm:p-8"
          aria-describedby={error ? 'login-error' : undefined}
        >
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          <p className="mt-1.5 text-base text-muted">{subtitle}</p>

          <label className="mt-7 block text-sm font-medium text-ink" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={`mt-1.5 ${inputClass}`}
          />

          <label className="mt-4 block text-sm font-medium text-ink" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={`mt-1.5 ${inputClass}`}
          />

          {error && (
            <p
              id="login-error"
              role="alert"
              className="mt-4 flex gap-2 rounded-md border border-danger/25 bg-danger-tint px-3 py-2.5 text-sm text-ink"
            >
              <IconAlert size={15} className="mt-0.5 text-danger" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={buttonClass({ size: 'lg', className: 'mt-6 w-full' })}
          >
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
          {alternative}
        </form>
        <p className="mt-6 text-center text-sm text-muted">
          New here?{' '}
          <Link
            className="font-medium text-accent underline-offset-4 hover:underline"
            to={signUp.to}
          >
            {signUp.label}
          </Link>
        </p>
      </div>
    </main>
  );
}
