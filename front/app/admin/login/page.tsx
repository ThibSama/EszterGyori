import type { Metadata } from "next";
import Link from "next/link";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";

export const metadata: Metadata = {
  title: "Connexion",
  robots: PRIVATE_ROBOTS,
};

/**
 * `/admin/login` — a placeholder, on purpose (ESZ-020).
 *
 * What stood here was a working form: it read `?error` and `?next` from the query
 * string, checked for an existing session, and posted to `/admin/auth/login`,
 * a Next route handler that verified a password with `node:crypto` and signed a
 * JWT with `jose`. Every one of those needs a Node process at request time, and
 * there is none on the target host.
 *
 * The route is kept — deleting it would 404 a link people have bookmarked, and
 * `.htaccess` routes `/admin/*` to the shell regardless — but the form is not.
 * Rendering inputs that post to an endpoint the contract still freezes at 404
 * would fail confusingly, and rendering a form that "logs in" against anything
 * the browser can see would be theatre: the check and the session would both be
 * under the caller's control.
 *
 * Package 2.2 replaces this with a form posting to `/api/auth/login`, against a
 * PHP session — opaque server-side id, `password_verify()`, per-session CSRF
 * token, throttled attempts (`docs/hetzner-target-architecture.md` §6). The page
 * says so rather than pretending, because an admin who cannot tell "not built
 * yet" from "broken" will file the wrong bug.
 */
export default function AdminLoginPage() {
  return (
    <main className="min-h-screen bg-warm-50 px-4 py-10 text-warm-800 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center">
        <div className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
          <div className="mb-8 space-y-2">
            <p className="text-sm font-medium uppercase tracking-wide text-sage-600">
              Administration
            </p>
            <h1 className="font-display text-3xl font-light text-warm-900">
              Connexion
            </h1>
          </div>

          <div
            role="status"
            className="mb-6 rounded-xl border border-warm-200 bg-warm-50 px-4 py-3 text-sm leading-relaxed text-warm-700">
            <p className="font-medium text-warm-900">
              L&apos;authentification n&apos;est pas encore disponible.
            </p>
            <p className="mt-1.5">
              Elle sera assurée par le serveur lors de la mise en place du
              back-office. En attendant, l&apos;éditeur reste accessible et les
              brouillons sont conservés dans ce navigateur uniquement.
            </p>
          </div>

          <Link
            href="/admin"
            className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
            Ouvrir l&apos;éditeur
          </Link>

          <Link
            href="/"
            className="mt-6 inline-flex text-sm font-medium text-sage-700 transition hover:text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
            Retour au site public
          </Link>
        </div>
      </div>
    </main>
  );
}
