import type { Metadata } from "next";
import { AdminShell } from "../../components/admin/admin-shell";
import { AdminSessionProvider } from "../../components/admin/admin-session-provider";
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
 *
 * The chrome itself moved into {@link AdminShell} (ESZ-154). This layout is the
 * only place that mounts it, which is what keeps every protected view on one
 * navigation instead of a per-page copy.
 */
export default function ProtectedAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AdminSessionProvider>
      <AdminShell>{children}</AdminShell>
    </AdminSessionProvider>
  );
}
