import { AdminOverview } from "../../components/admin/admin-overview";

/**
 * `/admin` — the operational overview (ESZ-155).
 *
 * This route used to render the CMS directly. The editor now lives at
 * `/admin/content`; what stands here answers the questions Esther opens the
 * back-office with, from data the application already serves.
 */
export default function AdminPage() {
  return <AdminOverview />;
}
