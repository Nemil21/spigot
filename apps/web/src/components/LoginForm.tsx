import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../api/client';
import { errorMessage } from './ErrorBanner';

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
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-lg font-semibold text-accent">Spigot</p>
        <form
          onSubmit={onSubmit}
          noValidate
          className="rounded-lg border border-line bg-surface p-6 shadow-card"
          aria-describedby={error ? 'login-error' : undefined}
        >
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>

          <label className="mt-6 block text-sm font-medium text-ink" htmlFor="login-email">
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
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-ink focus:outline-2 focus:outline-focus"
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
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-ink focus:outline-2 focus:outline-focus"
          />

          {error && (
            <p
              id="login-error"
              role="alert"
              className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full rounded-md bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-60"
          >
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
          {alternative}
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          New here?{' '}
          <Link className="font-medium text-accent hover:underline" to={signUp.to}>
            {signUp.label}
          </Link>
        </p>
      </div>
    </main>
  );
}
