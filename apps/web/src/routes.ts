/**
 * Every web path, fixed here (SP-024a) so screens, nav and links agree. The API serves index.html
 * only for `/`, `/app/*` and `/buyers/*` (apps/api/src/routes/web.ts), so every SPA path lives
 * under those. `/c/*` (W13 catalog, SP-033) is server-rendered and not part of this app.
 */
export const paths = {
  landing: '/',
  // Publisher, no shell
  login: '/app/login',
  signUp: '/app/signup',
  connectSite: '/app/connect',
  installVerify: '/app/install',
  // Publisher shell
  overview: '/app',
  recordTypes: '/app/record-types',
  datasetEditor: '/app/datasets/:datasetId',
  recordsBrowser: '/app/records',
  earnings: '/app/earnings',
  payouts: '/app/payouts',
  crawls: '/app/crawls',
  settings: '/app/settings',
  adminAudit: '/app/admin/audit',
  // Buyer
  buyerLogin: '/buyers/login',
  buyerSignUp: '/buyers/signup',
  buyerPortal: '/buyers',
  /** Top-up return (api.md: `/topups/return` 302s to `/buyers/topup/:id?ok=1`). Renders W11. */
  buyerTopup: '/buyers/topup/:topupId',
  buyerUsage: '/buyers/usage',
} as const;

export type PathName = keyof typeof paths;

/** Fill `:params` in a path: `href('datasetEditor', { datasetId: 'd1' })` → `/app/datasets/d1`. */
export function href(name: PathName, params: Record<string, string> = {}): string {
  return paths[name].replace(/:([A-Za-z]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`href(${name}): missing :${k}`);
    return encodeURIComponent(v);
  });
}

export interface NavItem {
  label: string;
  to: string;
  /** Match only the exact path (the Overview index). */
  end?: boolean;
}

/** Publisher left nav (W04; SP-024b's PublisherShell renders it). */
export const publisherNav: readonly NavItem[] = [
  { label: 'Overview', to: paths.overview, end: true },
  { label: 'Record types', to: paths.recordTypes },
  { label: 'Earnings', to: paths.earnings },
  { label: 'Payouts', to: paths.payouts },
  { label: 'Crawls', to: paths.crawls },
  { label: 'Settings', to: paths.settings },
];

/** Buyer nav (SP-024b's BuyerShell renders it). */
export const buyerNav: readonly NavItem[] = [
  { label: 'Balance and keys', to: paths.buyerPortal, end: true },
  { label: 'Usage', to: paths.buyerUsage },
];
