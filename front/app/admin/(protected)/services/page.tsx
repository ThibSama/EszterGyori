import { AdminServices } from "../../../components/admin/admin-services";

/**
 * `/admin/services` — the `Prestations` destination (ESZ-149).
 *
 * The page is the catalog editor and nothing else: the list of services with
 * their duration and status, and the form that adds or edits one. The shell's
 * `Prestations` entry became a real link the moment this route existed; it
 * points here and nowhere else.
 */
export default function AdminServicesPage() {
  return <AdminServices />;
}
