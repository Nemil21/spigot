import { loadCoreSdkScript } from '@paypal/paypal-js/sdk-v6';

/**
 * PayPal JS SDK v6, `paypal-payments` component only (features/08 §Manual top-up 3). The browser
 * gets the **client id** from `GET /api/buyer/paypal-config`; the client secret stays on the
 * server. Only the slice of the SDK the top-up uses is typed here, so tests can hand
 * `PayPalTopUp` a fake with the same shape.
 */
export interface PayPalConfig {
  /** Null under `PAYPAL_MODE=stub` (FakePayPal has no browser approval). */
  clientId: string | null;
  environment: 'sandbox' | 'production';
}

export interface ApproveData {
  orderId: string;
}

export interface OneTimeSessionOptions {
  onApprove: (data: ApproveData) => Promise<void>;
  onCancel?: (data: { orderId?: string }) => void;
  onError?: (error: Error) => void;
}

export interface OneTimeSession {
  start(
    options: { presentationMode: 'auto' | 'popup' | 'modal' },
    order: Promise<{ orderId: string }>,
  ): Promise<unknown>;
}

export interface PayPalSdk {
  /** True when the PayPal wallet button can be shown for USD. */
  isPayPalEligible(): Promise<boolean>;
  createSession(options: OneTimeSessionOptions): OneTimeSession;
}

export type LoadPayPalSdk = (config: {
  clientId: string;
  environment: PayPalConfig['environment'];
}) => Promise<PayPalSdk>;

/** The real loader: injects PayPal's v6 core script, then `createInstance({ clientId })`. */
export const loadPayPalSdk: LoadPayPalSdk = async ({ clientId, environment }) => {
  const paypal = await loadCoreSdkScript({ environment });
  if (!paypal) throw new Error('PayPal did not load.');
  const sdk = await paypal.createInstance({
    clientId,
    components: ['paypal-payments'],
    pageType: 'checkout',
  });
  return {
    async isPayPalEligible() {
      const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
      return methods.isEligible('paypal');
    },
    createSession(options) {
      return sdk.createPayPalOneTimePaymentSession({
        onApprove: options.onApprove,
        onCancel: options.onCancel,
        onError: options.onError,
      }) as unknown as OneTimeSession;
    },
  };
};
