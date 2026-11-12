import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { RootLayout, RouteError } from './RootLayout';
import { paths } from './routes';

/**
 * Every screen is pre-registered here as a lazy route (SP-024a), so a screen ticket replaces only
 * its own page file and never edits this one. Pages and shells default-export their component.
 */
type PageModule = { default: ComponentType };
const page = (load: () => Promise<PageModule>) => async () => ({
  Component: (await load()).default,
});

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { path: paths.landing, lazy: page(() => import('./pages/Landing')) },
      { path: paths.login, lazy: page(() => import('./pages/Login')) },
      { path: paths.signUp, lazy: page(() => import('./pages/onboarding/SignUp')) },
      { path: paths.connectSite, lazy: page(() => import('./pages/onboarding/ConnectSite')) },
      { path: paths.installVerify, lazy: page(() => import('./pages/onboarding/InstallVerify')) },
      {
        lazy: page(() => import('./layout/PublisherShell')),
        children: [
          { path: paths.overview, lazy: page(() => import('./pages/Overview')) },
          { path: paths.recordTypes, lazy: page(() => import('./pages/RecordTypes')) },
          { path: paths.datasetEditor, lazy: page(() => import('./pages/DatasetEditor')) },
          { path: paths.recordsBrowser, lazy: page(() => import('./pages/RecordsBrowser')) },
          { path: paths.earnings, lazy: page(() => import('./pages/Earnings')) },
          { path: paths.payouts, lazy: page(() => import('./pages/Payouts')) },
          { path: paths.crawls, lazy: page(() => import('./pages/Crawls')) },
          { path: paths.settings, lazy: page(() => import('./pages/Settings')) },
          { path: paths.adminAudit, lazy: page(() => import('./pages/admin/Audit')) },
          // Dev check page (SP-024a): AG Grid + Charts licence and theme. Not in any nav.
          { path: '/app/dev/ag', lazy: page(() => import('./pages/dev/AgCheck')) },
          { path: '/app/*', lazy: page(() => import('./pages/NotFound')) },
        ],
      },
      { path: paths.buyerLogin, lazy: page(() => import('./pages/buyer/Login')) },
      { path: paths.buyerSignUp, lazy: page(() => import('./pages/buyer/SignUp')) },
      {
        lazy: page(() => import('./layout/BuyerShell')),
        children: [
          { path: paths.buyerPortal, lazy: page(() => import('./pages/buyer/Portal')) },
          { path: paths.buyerTopup, lazy: page(() => import('./pages/buyer/Portal')) },
          { path: paths.buyerUsage, lazy: page(() => import('./pages/buyer/Usage')) },
          { path: '/buyers/*', lazy: page(() => import('./pages/NotFound')) },
        ],
      },
      { path: '*', lazy: page(() => import('./pages/NotFound')) },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
