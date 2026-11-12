import { LoginForm } from '../components/LoginForm';
import { paths } from '../routes';

/** Publisher login (features/14 §Auth): `POST /api/auth/login`, then the dashboard. */
export default function LoginPage() {
  return (
    <LoginForm
      endpoint="/api/auth/login"
      home={paths.overview}
      title="Log in"
      subtitle="See who's crawling your site and what they've paid."
      signUp={{ to: paths.signUp, label: 'Connect your site' }}
    />
  );
}
