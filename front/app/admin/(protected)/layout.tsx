import type { Metadata } from "next";
import Link from "next/link";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";

export const metadata: Metadata = {
  title: "Administration",
  robots: PRIVATE_ROBOTS,
};

/**
 * The admin chrome (ESZ-020).
 *
 * This layout used to `await requireAdminSession()`, which is what made `/admin`
 * a dynamic route and the whole frontend unexportable. The gate is gone because a
 * static file cannot enforce one — not because the requirement went away.
 *
 * **`/admin` is not access-controlled in this package.** Package 2.2 puts the
 * enforcement in PHP, where it belongs: the shell may redirect for UX, but every
 * `/api/admin/*` call is authorised server-side and the API is the authority
 * (`docs/hetzner-target-architecture.md` §6). Re-creating the check in the
 * browser would look like security and be none — the check and the thing it
 * guards would both be under the caller's control — so nothing stands in for it
 * here. The gap is tracked in `docs/v1-quality-gates.md`; until 2.2 lands, the
 * deployment note in `php/public/.htaccess` is the only server-side option.
 *
 * Nothing under `/admin` can leak a secret in the meantime: the shell has no
 * server API to read from, and drafts still live in the editor's own browser.
 */
export default function ProtectedAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <div className="sticky top-0 z-50 border-b border-warm-200 bg-white/85 px-4 py-3 text-warm-800 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:px-2 2xl:px-4">
          <p className="text-sm font-medium">Administration Eszter</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/75 px-4 py-2 text-sm font-medium text-warm-700 transition hover:-translate-y-px hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
              ← Retour au site
            </Link>
          </div>
        </div>
      </div>
      {children}
    </>
  );
}
