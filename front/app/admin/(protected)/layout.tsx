import type { Metadata } from "next";
import Link from "next/link";
import {
  AdminSessionBadge,
  AdminSessionProvider,
} from "../../components/admin/admin-session-provider";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";

export const metadata: Metadata = {
  title: "Administration",
  robots: PRIVATE_ROBOTS,
};

/**
 * The admin chrome (ESZ-020, ESZ-034).
 *
 * This layout used to `await requireAdminSession()`, which is what made `/admin`
 * a dynamic route and the whole frontend unexportable. It still does not gate
 * anything, and cannot: `/admin` is a static file, so a check written here runs
 * in the browser of the person it is meant to stop.
 *
 * What changed in Package 3.2 is that there is now a session to *ask about*.
 * {@link AdminSessionProvider} calls `GET /api/auth/session` on mount and renders
 * the editor only for a caller PHP reports as signed in. That is a rendering
 * decision — it stops an anonymous visitor being shown an editor whose every
 * button would 401 — and it is not access control. The authority is unchanged:
 * every `/api/admin/*` call is authorised server-side, per request, and a
 * disabled account is refused on its next call rather than at its next login
 * (`auth.accessControl`, `docs/hetzner-target-architecture.md` §6).
 *
 * The consequence worth stating: the editor below this point can assume a session
 * existed *when it rendered*, and must still handle a 401 on every call, because
 * the session can end between two of them.
 */
export default function ProtectedAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AdminSessionProvider>
      <div className="sticky top-0 z-50 border-b border-warm-200 bg-white/85 px-4 py-3 text-warm-800 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:px-2 2xl:px-4">
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-sm font-medium">Administration Eszter</p>
            <nav aria-label="Navigation de l’administration" className="flex gap-1">
              <Link href="/admin" className="rounded-full px-3 py-2 text-sm text-warm-700 hover:bg-warm-100 focus:outline-none focus:ring-2 focus:ring-sage-300">Contenu</Link>
              <Link href="/admin/bookings" className="rounded-full px-3 py-2 text-sm text-warm-700 hover:bg-warm-100 focus:outline-none focus:ring-2 focus:ring-sage-300">Rendez-vous</Link>
              <Link href="/admin/availability" className="rounded-full px-3 py-2 text-sm text-warm-700 hover:bg-warm-100 focus:outline-none focus:ring-2 focus:ring-sage-300">Disponibilités</Link>
            </nav>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/75 px-4 py-2 text-sm font-medium text-warm-700 transition hover:-translate-y-px hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
              ← Retour au site
            </Link>
            <AdminSessionBadge />
          </div>
        </div>
      </div>
      {children}
    </AdminSessionProvider>
  );
}
