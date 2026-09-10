import type { AdminBooking } from "./admin-api";
import type { AdminAvailabilityException } from "./admin-api";
import {
  type DateWindow,
  type WeeklyRuleDraft,
  dateWindows,
  isoWeekday,
} from "./admin-availability";
import { addCivilDays, bookingsForDate, formatParisTime } from "./admin-booking-calendar";

/**
 * The week the unified calendar renders (ESZ-159).
 *
 * Everything here is geometry and projection, and none of it is a rule. The
 * question "is this date open, and for which windows?" is answered in exactly
 * one place — `dateWindows` in `admin-availability` — and this module only asks
 * it once per day and lays the answer out beside the appointments. That is the
 * whole reason the week view can show planning constraints next to bookings
 * without a second opinion about what a constraint is: there is no slot maths,
 * no business rule and no new temporal domain type below this line. The server
 * remains the authority on both halves; this is a projection of what it said.
 */

/** Monday of the week containing `date`, as a civil Paris date. */
export function startOfWeek(date: string): string {
  return addCivilDays(date, 1 - isoWeekday(date));
}

/** The Monday `delta` weeks away from the week containing `date`. */
export function shiftWeek(date: string, delta: number): string {
  return addCivilDays(startOfWeek(date), delta * 7);
}

/** Monday through Sunday of the week containing `date`. */
export function weekDays(date: string): string[] {
  const monday = startOfWeek(date);
  return Array.from({ length: 7 }, (_, index) => addCivilDays(monday, index));
}

/**
 * The week's own heading, e.g. "1 – 7 juin 2026".
 *
 * A week that straddles two months or two years spells both sides out rather
 * than letting the reader assume the first date's month carried over.
 */
export function weekRangeLabel(days: string[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const format = (value: string, withMonth: boolean, withYear: boolean) =>
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "UTC",
      day: "numeric",
      ...(withMonth ? { month: "long" as const } : {}),
      ...(withYear ? { year: "numeric" as const } : {}),
    }).format(new Date(`${value}T12:00:00Z`));

  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${format(first, !sameMonth, !sameYear)} – ${format(last, true, true)}`;
}

/** Minutes since midnight of a `HH:MM` local time. */
export function minutesOfLocalTime(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Minutes since Paris midnight of an instant, on the civil day it falls in. */
function parisMinutes(instant: string): number {
  return minutesOfLocalTime(formatParisTime(instant));
}

/**
 * The hour rows the week needs, wide enough for every window and every
 * appointment in it.
 *
 * A fixed 00–24 grid would spend most of its height on hours the salon is never
 * open, and a fixed 09–19 one would silently crop an appointment that was moved
 * outside the usual hours — which is exactly the row an operator most needs to
 * see. So the span is derived from what is actually there, and only falls back
 * to a default when the week holds nothing at all.
 */
export function weekHourSpan(
  days: string[],
  rules: WeeklyRuleDraft[],
  exceptions: AdminAvailabilityException[],
  bookings: AdminBooking[],
): { firstHour: number; lastHour: number } {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const date of days) {
    for (const window of dateWindows(date, rules, exceptions).windows) {
      starts.push(minutesOfLocalTime(window.startLocal));
      ends.push(minutesOfLocalTime(window.endLocal));
    }
    for (const booking of bookingsForDate(bookings, date)) {
      starts.push(parisMinutes(booking.startsAtUtc));
      // An appointment ending after midnight reads as ending at midnight rather
      // than wrapping the grid around to the previous hour.
      const end = parisMinutes(booking.endsAtUtc);
      ends.push(end <= parisMinutes(booking.startsAtUtc) ? 24 * 60 : end);
    }
  }

  if (starts.length === 0) return { firstHour: 8, lastHour: 19 };

  const firstHour = Math.max(0, Math.floor(Math.min(...starts) / 60));
  const lastHour = Math.min(24, Math.ceil(Math.max(...ends) / 60));
  return { firstHour, lastHour: Math.max(lastHour, firstHour + 1) };
}

/** True when the `[hour, hour + 1)` block overlaps any of `windows`. */
export function isHourOpen(hour: number, windows: DateWindow[]): boolean {
  const blockStart = hour * 60;
  const blockEnd = blockStart + 60;
  return windows.some(
    (window) =>
      minutesOfLocalTime(window.startLocal) < blockEnd &&
      blockStart < minutesOfLocalTime(window.endLocal),
  );
}

/** One appointment as the grid places it: which hour row, and how tall. */
export interface WeekAppointment {
  booking: AdminBooking;
  /** Hour row it starts in, so a 09:30 appointment sits in the 09 row. */
  hour: number;
  startLocal: string;
  endLocal: string;
  /** Whole hour rows it spans, at least one. */
  span: number;
}

/** One day column: its availability, and the appointments standing in it. */
export interface WeekDayPlan {
  date: string;
  isToday: boolean;
  kind: "closed" | "exception" | "weekly";
  windows: DateWindow[];
  appointments: WeekAppointment[];
}

/**
 * The whole week, projected once.
 *
 * Bookings keep the server's ordering and their own state — a cancelled
 * appointment is projected exactly like a confirmed one, because it stays
 * visible in the calendar and only its styling differs.
 */
export function weekPlan(
  days: string[],
  rules: WeeklyRuleDraft[],
  exceptions: AdminAvailabilityException[],
  bookings: AdminBooking[],
  today: string,
): WeekDayPlan[] {
  return days.map((date) => {
    const availability = dateWindows(date, rules, exceptions);
    return {
      date,
      isToday: date === today,
      kind: availability.kind,
      windows: availability.windows,
      appointments: bookingsForDate(bookings, date).map((booking) => {
        const startMinutes = parisMinutes(booking.startsAtUtc);
        const rawEnd = parisMinutes(booking.endsAtUtc);
        const endMinutes = rawEnd <= startMinutes ? 24 * 60 : rawEnd;
        const hour = Math.floor(startMinutes / 60);
        return {
          booking,
          hour,
          startLocal: formatParisTime(booking.startsAtUtc),
          endLocal: formatParisTime(booking.endsAtUtc),
          span: Math.max(1, Math.ceil(endMinutes / 60) - hour),
        };
      }),
    };
  });
}

/** The short weekday heads of the week grid, Monday first. */
export const WEEK_DAY_HEADS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"] as const;

/** How a day column announces its availability, in one line. */
export function dayAvailabilityLabel(plan: WeekDayPlan): string {
  if (plan.windows.length === 0) return "Fermé";
  const windows = plan.windows
    .map((window) => `${window.startLocal} – ${window.endLocal}`)
    .join(", ");
  return plan.kind === "exception" ? `Exceptionnel : ${windows}` : windows;
}
