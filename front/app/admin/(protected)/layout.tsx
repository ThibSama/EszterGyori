import { requireAdminSession } from "../../lib/auth";
import Link from "next/link";

export default async function ProtectedAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await requireAdminSession();

  return (
    <>
      <div className="border-b border-warm-200 bg-white/85 px-4 py-3 text-warm-800 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium">Administration Eszter</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/75 px-4 py-2 text-sm font-medium text-warm-700 transition hover:-translate-y-px hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
              ← Retour au site
            </Link>
            <form action="/admin/auth/logout" method="post">
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center rounded-full border border-red-300/80 bg-red-50 px-4 py-2 text-sm font-medium text-red-800 shadow-sm transition hover:-translate-y-px hover:border-red-400 hover:bg-red-100 hover:text-red-900 hover:shadow-[0_8px_22px_rgba(127,29,29,0.12)] active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-red-300 sm:w-auto">
              Se déconnecter
            </button>
            </form>
          </div>
        </div>
      </div>
      {children}
    </>
  );
}
