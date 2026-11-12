import { LoginForm } from '../../components/LoginForm';
import { paths } from '../../routes';

/** Buyer portal login (features/14 §Auth): `POST /api/buyer/login`, then the portal. */
export default function LoginPage() {
  return (
    <LoginForm
      endpoint="/api/buyer/login"
      home={paths.buyerPortal}
      title="Log in for agents"
      subtitle="Your balance, API keys and Claude Desktop config."
      signUp={{ to: paths.buyerSignUp, label: 'Create a buyer account' }}
    />
  );
}
