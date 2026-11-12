import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import LoginPage from '../pages/Login';
import { SignUpFlow } from '../pages/onboarding/SignUp';
import { PAYPAL_MESSAGES, paypalMessage } from './PayPalSignIn';

/** SP-058 Log in with PayPal on W02 (login + sign up): the button and the callback's notices. */

function renderAt(entry: string, element: React.ReactNode) {
  const path = entry.split('?', 1)[0]!;
  const router = createMemoryRouter([{ path, element }], { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
}

describe('Log in with PayPal (SP-058)', () => {
  it('the publisher login page links to /api/auth/paypal/start (a full-page navigation)', () => {
    renderAt('/app/login', <LoginPage />);
    const link = screen.getByRole('link', { name: /Log in with PayPal/ });
    expect(link).toHaveAttribute('href', '/api/auth/paypal/start');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['cancelled', 'PayPal sign-in was cancelled.'],
    ['link-required', 'Log in with your password, then connect PayPal'],
    ['unverified', 'confirmed email address'],
    ['state', 'expired'],
    ['error', 'didn’t work'],
  ])('login shows ?paypal=%s', (reason, text) => {
    renderAt(`/app/login?paypal=${reason}`, <LoginPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('ignores an unknown ?paypal= value', () => {
    renderAt('/app/login?paypal=<script>', <LoginPage />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(paypalMessage('constructor')).toBeNull();
    expect(paypalMessage(null)).toBeNull();
  });

  it('W02 sign up offers Sign up with PayPal under the account form', () => {
    renderAt('/app/signup', <SignUpFlow />);
    expect(screen.getByRole('link', { name: /Sign up with PayPal/ })).toHaveAttribute(
      'href',
      '/api/auth/paypal/start',
    );
    expect(screen.getByText(/verified PayPal email becomes your payout email/)).toBeInTheDocument();
  });

  it('every callback reason has copy', () => {
    for (const r of [
      'connected',
      'cancelled',
      'state',
      'unverified',
      'link-required',
      'taken',
      'error',
    ]) {
      expect(PAYPAL_MESSAGES[r as keyof typeof PAYPAL_MESSAGES]).toBeTruthy();
    }
  });
});
