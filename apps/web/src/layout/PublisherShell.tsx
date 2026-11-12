import { paths, publisherNav } from '../routes';
import { AppShell } from './AppShell';
import { loadPublisherSession, useSession, type PublisherSession } from './session';

/** Publisher dashboard shell (W04–W10, W16): left nav from `publisherNav`, session guard. */
export default function PublisherShell() {
  const session = useSession<PublisherSession>(loadPublisherSession);
  return (
    <AppShell
      area="Publisher"
      brand="Spigot"
      nav={publisherNav}
      session={session}
      loginPath={paths.login}
      logoutEndpoint="/api/auth/logout"
      badge={(p) => (p.isDemo ? 'Demo account' : null)}
    />
  );
}
