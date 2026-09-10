import { AdminBookingCalendar } from "../../../components/admin/admin-booking-calendar";
import { AdminOperationsSummary } from "../../../components/admin/admin-operations-summary";

/**
 * `/admin/bookings` — the Calendar (ESZ-159).
 *
 * This is the one admin destination that owns appointments *and* the availability
 * that constrains them. It used to own only the first half, with weekly hours and
 * date exceptions living at `/admin/availability`, which meant the two questions
 * an operator asks together — "what is booked this week?" and "when am I open?" —
 * were answered on two screens that could not show each other.
 *
 * `/admin/availability` still resolves, and resolves *here*: it renders this same
 * component with its availability panel already open, so the old address is a way
 * into one product rather than a second product with its own behaviour.
 */
export default function AdminBookingsPage() {
  return (
    <>
      <AdminOperationsSummary />
      <AdminBookingCalendar />
    </>
  );
}
