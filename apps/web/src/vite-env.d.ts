/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1": GET calls resolve from src/fixtures/**.json when a file matches (api/client.ts). */
  readonly VITE_FIXTURES?: string;
  /** AG Grid + AG Charts Enterprise licence (falls back to AG_GRID_LICENSE_KEY in vite.config.ts). */
  readonly VITE_AG_GRID_LICENSE_KEY?: string;
  /** PayPal JS SDK v6 client id (public), for the buyer top-up page (SP-032). */
  readonly VITE_PAYPAL_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
