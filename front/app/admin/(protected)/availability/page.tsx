import { AdminBookingCalendar } from "../../../components/admin/admin-booking-calendar";
import { AdminOperationsSummary } from "../../../components/admin/admin-operations-summary";

/**
 * `/admin/availability` — the compatibility path into the Calendar (ESZ-159).
 *
 * Availability lost its own page when the Calendar absorbed it. What it did not
 * lose is its address: this route is bookmarked, it is what the shell's
 * `alsoMatches` already pointed `Calendrier` at, and a static export has no
 * server redirect to offer anyway.
 *
 * So the route converges rather than dying or diverging. It renders the unified
 * Calendar — the same component, the same state, the same appointment and
 * availability behaviour as `/admin/bookings` — with the availability panel
 * opened on arrival, which is what the person who typed this address came for.
 * The one thing it deliberately is not is a second implementation: there is no
 * copy of the editor here to drift out of step with the one in the Calendar.
 */
export default function AdminAvailabilityPage() {
  return (
    <>
      <AdminOperationsSummary />
      <AdminBookingCalendar initialPanel="availability" />
    </>
  );
}
