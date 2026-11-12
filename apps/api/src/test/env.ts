/** The minimum environment the API boots with (fake values; never real secrets). */
export const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://spigot:spigot@localhost:5432/spigot_test',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  APP_BASE_URL: 'http://localhost:3000',
};
