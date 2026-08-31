import { AdminBookingCalendar } from "../../../components/admin/admin-booking-calendar";
import { AdminOperationsSummary } from "../../../components/admin/admin-operations-summary";

export default function AdminBookingsPage() {
  return (
    <>
      <AdminOperationsSummary />
      <AdminBookingCalendar />
    </>
  );
}
