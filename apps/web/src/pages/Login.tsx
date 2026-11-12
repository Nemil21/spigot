import { useSearchParams } from 'react-router';
import { LoginForm } from '../components/LoginForm';
import { PayPalAlternative, PayPalNotice } from '../components/PayPalSignIn';
import { paths } from '../routes';

/**
 * Publisher login (features/14 §Auth): `POST /api/auth/login`, then the dashboard; or Log in with
 * PayPal (SP-058), whose callback comes back here with `?paypal=<reason>` when it can't sign in.
 */
export default function LoginPage() {
  const [params] = useSearchParams();
  return (
    <LoginForm
      endpoint="/api/auth/login"
      home={paths.overview}
      title="Log in"
      subtitle="See who's crawling your site and what they've paid."
      signUp={{ to: paths.signUp, label: 'Connect your site' }}
      alternative={
        <>
          <PayPalNotice reason={params.get('paypal')} />
          <PayPalAlternative label="Log in with PayPal" />
        </>
      }
    />
  );
}
