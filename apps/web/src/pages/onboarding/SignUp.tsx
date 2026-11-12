import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api as defaultApi, ApiError, type ApiClient } from '../../api/client';
import { errorMessage } from '../../components';
import { PayPalAlternative } from '../../components/PayPalSignIn';
import { paths } from '../../routes';
import { ConnectSiteCard, StepHeading } from './ConnectSite';
import { cardClass, OnboardingLayout, primaryButton, TextField } from './kit';

export const PAYOUT_EMAIL_HINT = 'This is where PayPal Payouts send your earnings';
const PASSWORD_MIN = 8; // apps/api/src/auth/password.ts

type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'payoutEmail', string>>;

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * W02 Sign up + connect site (screens.md §W02; features/03, 14): one card, two steps.
 * (1) Account: `POST /api/auth/signup` `{ name, email, password, payoutEmail }` signs the new
 * publisher in. (2) Site: the connect form with its live origin check (ConnectSite.tsx).
 * "Sign up with PayPal" (SP-058) skips step 1: the callback creates the account and lands on step 2.
 */
export function SignUpFlow({
  client = defaultApi,
  initialStep = 1,
}: {
  client?: ApiClient;
  initialStep?: 1 | 2;
}) {
  const [step, setStep] = useState<1 | 2>(initialStep);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [payoutEmail, setPayoutEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<{ message: string; emailTaken: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = 'Enter your name.';
    if (!looksLikeEmail(email)) errs.email = 'Enter a valid email address.';
    if (password.length < PASSWORD_MIN) errs.password = `Use at least ${PASSWORD_MIN} characters.`;
    if (!looksLikeEmail(payoutEmail)) errs.payoutEmail = 'Enter the email of your PayPal account.';
    return errs;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const errs = validate();
    setFieldErrors(errs);
    setError(null);
    if (Object.keys(errs).length > 0) return;
    setSubmitting(true);
    try {
      await client.post('/api/auth/signup', {
        name: name.trim(),
        email: email.trim(),
        password,
        payoutEmail: payoutEmail.trim(),
      });
      setPassword('');
      setStep(2);
    } catch (err) {
      setError({
        message: errorMessage(err),
        emailTaken: err instanceof ApiError && err.code === 'STATE_CONFLICT',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 2) {
    return <ConnectSiteCard client={client} />;
  }

  return (
    <>
      <form onSubmit={onSubmit} noValidate className={cardClass} aria-busy={submitting}>
        <StepHeading
          step={1}
          title="Create your account"
          subtitle="Turn your site into a paid API for AI agents."
        />
        <TextField
          id="signup-name"
          label="Name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
        />
        <TextField
          id="signup-email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <TextField
          id="signup-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <TextField
          id="signup-payout-email"
          label="PayPal payout email"
          type="email"
          autoComplete="email"
          required
          value={payoutEmail}
          onChange={(e) => setPayoutEmail(e.target.value)}
          hint={PAYOUT_EMAIL_HINT}
          error={fieldErrors.payoutEmail}
        />

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger"
          >
            <p>{error.message}</p>
            {error.emailTaken && (
              <Link
                className="mt-1 inline-block font-medium text-accent hover:underline"
                to={paths.login}
              >
                Log in instead
              </Link>
            )}
          </div>
        )}

        <button type="submit" disabled={submitting} className={`mt-6 w-full ${primaryButton}`}>
          {submitting ? 'Creating your account…' : 'Continue'}
        </button>
        <PayPalAlternative
          label="Sign up with PayPal"
          hint="Your verified PayPal email becomes your payout email."
        />
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link className="font-medium text-accent hover:underline" to={paths.login}>
          Log in
        </Link>
      </p>
    </>
  );
}

export default function SignUpPage() {
  return (
    <OnboardingLayout>
      <SignUpFlow />
    </OnboardingLayout>
  );
}
