import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getOptionalAdminSession, sanitizeAdminRedirect } from "../../lib/auth";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";

export const metadata: Metadata = {
  title: "Connexion",
  robots: PRIVATE_ROBOTS,
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams?: Promise<{
    error?: string | string[];
    next?: string | string[];
  }>;
}) {
  const session = await getOptionalAdminSession();
  if (session) {
    redirect("/admin");
  }

  const params = (await searchParams) ?? {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const nextValue = Array.isArray(params.next) ? params.next[0] : params.next;
  const safeNext = sanitizeAdminRedirect(nextValue);
  const errorMessage =
    error === "unavailable"
      ? "Connexion temporairement indisponible."
      : error === "invalid"
        ? "Identifiants incorrects."
        : null;

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
            <p className="text-sm leading-relaxed text-warm-500">
              Acces reserve a l&apos;administration du contenu local.
            </p>
          </div>

          {errorMessage && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          <form action="/admin/auth/login" method="post" className="space-y-5">
            <input type="hidden" name="next" value={safeNext} />
            <div className="space-y-1.5">
              <label
                htmlFor="admin-username"
                className="block text-sm font-medium text-warm-800">
                Identifiant
              </label>
              <input
                id="admin-username"
                name="username"
                type="text"
                autoComplete="username"
                required
                className="w-full rounded-xl border border-warm-300 bg-white px-3 py-2.5 text-warm-900 outline-none transition focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="admin-password"
                className="block text-sm font-medium text-warm-800">
                Mot de passe
              </label>
              <input
                id="admin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full rounded-xl border border-warm-300 bg-white px-3 py-2.5 text-warm-900 outline-none transition focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
              Se connecter
            </button>
          </form>

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
