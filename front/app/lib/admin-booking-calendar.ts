import type { AdminBooking } from "./admin-api";

export const PARIS_TIME_ZONE = "Europe/Paris" as const;

function parts(instant: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: PARIS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function parisLocalDate(value: string | Date = new Date()): string {
  const valueParts = parts(typeof value === "string" ? new Date(value) : value);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}`;
}

export function formatParisTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: PARIS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function formatParisDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function addCivilDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function monthKey(value: string): string {
  return value.slice(0, 7);
}

export function shiftMonth(value: string, delta: number): string {
  const date = new Date(`${value.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function monthGrid(value: string): string[] {
  const first = `${value.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay() || 7;
  const start = addCivilDays(first, 1 - weekday);
  return Array.from({ length: 42 }, (_, index) => addCivilDays(start, index));
}

export function bookingsForDate(bookings: AdminBooking[], date: string): AdminBooking[] {
  return bookings
    .filter((booking) => parisLocalDate(booking.startsAtUtc) === date)
    .sort((left, right) => left.startsAtUtc.localeCompare(right.startsAtUtc));
}

export function replaceBooking(bookings: AdminBooking[], next: AdminBooking): AdminBooking[] {
  return [...bookings.filter((booking) => booking.reference !== next.reference), next].sort(
    (left, right) => left.startsAtUtc.localeCompare(right.startsAtUtc),
  );
}
