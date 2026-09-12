import { AdminSettings } from "../../../components/admin/admin-settings";

/**
 * `/admin/settings` — the `Paramètres` destination (ESZ-165).
 *
 * The shell's `Paramètres` entry became a real link the moment this route
 * existed; it points here and nowhere else. Today the page holds one
 * section, `Informations juridiques` — the legal document the two public
 * legal pages publish.
 */
export default function AdminSettingsPage() {
  return <AdminSettings />;
}
