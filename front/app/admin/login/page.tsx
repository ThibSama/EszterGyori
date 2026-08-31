import type { Metadata } from "next";
import { AdminLoginForm } from "../../components/admin/admin-login-form";
import { PRIVATE_ROBOTS } from "../../lib/metadata/site-metadata";

export const metadata: Metadata = {
  title: "Connexion",
  robots: PRIVATE_ROBOTS,
};

/**
 * `/admin/login` (ESZ-034).
 *
 * A static page whose only job is to render the client form. The page itself
 * stays a server component so it can keep exporting `metadata` — `robots: none`
 * matters more here than on any other route — while every part that needs a
 * `fetch`, a session and a token lives in {@link AdminLoginForm}.
 *
 * Nothing on this route enforces anything. It posts credentials to PHP, which is
 * the only thing that can check them, and the reason that used to make this page
 * a placeholder — there was no endpoint to post to — no longer holds.
 */
export default function AdminLoginPage() {
  return <AdminLoginForm />;
}
