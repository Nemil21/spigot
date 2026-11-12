import { buyerNav, paths } from '../routes';
import { AppShell } from './AppShell';
import { loadBuyerSession, useSession, type BuyerSession } from './session';

/** Buyer portal shell (W11, W12): buyer nav, session guard on the 30-day buyer cookie. */
export default function BuyerShell() {
  const session = useSession<BuyerSession>(loadBuyerSession);
  return (
    <AppShell
      area="Buyer"
      brand="Spigot for agents"
      nav={buyerNav}
      session={session}
      loginPath={paths.buyerLogin}
      logoutEndpoint="/api/buyer/logout"
    />
  );
}
