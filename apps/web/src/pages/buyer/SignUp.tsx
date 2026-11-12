import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../../api/client';
import { errorMessage } from '../../components';
import { paths } from '../../routes';
import { AuthBackdrop, Logo } from '../../components/Brand';

const PASSWORD_MIN = 8;

const field =
  'mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-ink focus:outline-2 focus:outline-focus';

/**
 * Buyer sign up (W11 entry; api.md `POST /api/buyer/signup` → signed in), then the portal, where
 * the buyer tops up with PayPal and creates an API key.
 */
export function BuyerSignUp({ client = defaultApi }: { client?: ApiClient }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim() || !email.trim()) return setError('Enter your name and email.');
    if (password.length < PASSWORD_MIN) {
      return setError(`Use a password of at least ${PASSWORD_MIN} characters.`);
    }
    setSubmitting(true);
    setError(null);
    try {
      await client.post('/api/buyer/signup', { name: name.trim(), email: email.trim(), password });
      navigate(paths.buyerPortal, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'STATE_CONFLICT'
          ? 'That email already has an account. Log in instead.'
          : errorMessage(err),
      );
      setSubmitting(false);
    }
  }

  return (
    <AuthBackdrop>
      <div className="w-full max-w-sm">
        <p className="mb-6 flex justify-center">
          <Logo />
        </p>
        <form
          onSubmit={onSubmit}
          noValidate
          className="rounded-[22px] border border-white/10 bg-surface/85 p-8 shadow-card backdrop-blur-xl"
          aria-describedby={error ? 'signup-error' : undefined}
        >
          <h1 className="text-xl font-semibold text-ink">Create a buyer account</h1>
          <p className="mt-1 text-sm text-muted">
            Fund your agent with PayPal and connect it to Claude Desktop.
          </p>

          <label className="mt-6 block text-sm font-medium text-ink" htmlFor="signup-name">
            Name
          </label>
          <input
            id="signup-name"
            name="name"
            autoComplete="organization"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />

          <label className="mt-4 block text-sm font-medium text-ink" htmlFor="signup-email">
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />

          <label className="mt-4 block text-sm font-medium text-ink" htmlFor="signup-password">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="signup-password-hint"
            className={field}
          />
          <p id="signup-password-hint" className="mt-1.5 text-xs text-muted">
            At least {PASSWORD_MIN} characters.
          </p>

          {error && (
            <p
              id="signup-error"
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
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          Have an account?{' '}
          <Link className="font-medium text-accent hover:underline" to={paths.buyerLogin}>
            Log in
          </Link>
        </p>
      </div>
    </AuthBackdrop>
  );
}

export default function SignUpPage() {
  return <BuyerSignUp />;
}
