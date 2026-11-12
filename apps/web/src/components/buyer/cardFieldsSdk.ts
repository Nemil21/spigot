import { loadCoreSdkScript } from '@paypal/paypal-js/sdk-v6';
import type { PayPalConfig } from './paypalSdk';

/**
 * PayPal JS SDK v6, `card-fields` component only (SP-063; features/08 §Manual top-up 7). Same
 * client id as the PayPal button (`GET /api/buyer/paypal-config`); the card number, expiry and CVV
 * are typed into PayPal-hosted fields and go straight to PayPal: Spigot's API never sees them.
 * Only the slice `CardFieldsTopUp` uses is typed here, so tests can hand it a fake.
 */
export type CardFieldType = 'name' | 'number' | 'expiry' | 'cvv';

export interface CardSubmitResult {
  /** `succeeded` → capture; `canceled` (3DS closed) / `failed` (declined, invalid) → no capture. */
  state: 'succeeded' | 'canceled' | 'failed';
  data?: { orderId?: string; message?: string; liabilityShift?: string };
}

export interface CardFieldsSession {
  /** A PayPal-hosted input (an iframe-backed element) to append to the page. */
  createField(options: { type: CardFieldType; placeholder: string; label?: string }): HTMLElement;
  /** Send the card to PayPal for our order (`POST /api/buyer/topups` with `method: 'CARD'`). */
  submit(orderId: string): Promise<CardSubmitResult>;
  destroy(): void;
}

export interface CardFieldsSdk {
  /** True when PayPal offers advanced card fields to this merchant for USD. */
  isCardFieldsEligible(): Promise<boolean>;
  createSession(): CardFieldsSession;
}

export type LoadCardFieldsSdk = (config: {
  clientId: string;
  environment: PayPalConfig['environment'];
}) => Promise<CardFieldsSdk>;

/** The real loader: PayPal's v6 core script, then `createInstance({ components: ['card-fields'] })`. */
export const loadCardFieldsSdk: LoadCardFieldsSdk = async ({ clientId, environment }) => {
  const paypal = await loadCoreSdkScript({ environment });
  if (!paypal) throw new Error('PayPal did not load.');
  const sdk = await paypal.createInstance({
    clientId,
    components: ['card-fields'],
    pageType: 'checkout',
  });
  return {
    async isCardFieldsEligible() {
      const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
      return methods.isEligible('advanced_cards');
    },
    createSession() {
      const session = sdk.createCardFieldsOneTimePaymentSession();
      return {
        createField: (options) => session.createCardFieldsComponent(options),
        // Sandbox buyers are US; PayPal wants the billing country with card fields (Holdfast S7).
        submit: (orderId) =>
          session.submit(orderId, {
            billingAddress: { countryCode: 'US' },
          }) as Promise<CardSubmitResult>,
        destroy: () => session.destroy(),
      };
    },
  };
};
