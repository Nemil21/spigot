import { useLocation } from 'react-router';
import { ButtonLink } from '../components/Button';
import { IconArrowRight } from '../components/icons';
import { paths } from '../routes';

/** In-app 404 for unknown `/app/*` and `/buyers/*` paths. Empty state: one sentence, one action. */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  const home = pathname.startsWith('/buyers') ? paths.buyerPortal : paths.overview;
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-4 py-16 sm:px-6"
      data-screen="404"
    >
      <p aria-hidden="true" className="font-mono text-5xl font-medium text-border tabular-nums">
        404
      </p>
      <h1 className="mt-4 text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-md text-body">
        There's nothing at <code className="font-mono text-sm break-all text-ink">{pathname}</code>.
      </p>
      <ButtonLink to={home} className="mt-8 self-start">
        Go to the dashboard
        <IconArrowRight size={14} />
      </ButtonLink>
    </section>
  );
}
