import { Link, useLocation } from 'react-router';
import { paths } from '../routes';

/** In-app 404 for unknown `/app/*` and `/buyers/*` paths. Empty state: one sentence, one action. */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  const home = pathname.startsWith('/buyers') ? paths.buyerPortal : paths.overview;
  return (
    <section className="mx-auto max-w-3xl px-6 py-16" data-screen="404">
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <p className="mt-4 text-body">There's nothing at {pathname}.</p>
      <Link className="mt-6 inline-block font-medium text-accent hover:underline" to={home}>
        Go to the dashboard
      </Link>
    </section>
  );
}
