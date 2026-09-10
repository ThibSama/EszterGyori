import { ADMIN_AVAILABILITY_MAX_RANGE_DAYS } from "@eszter/contracts";
import { addCivilDays } from "./admin-booking-calendar";

/**
 * Which availability the editor and the calendar actually hold (ESZ-159).
 *
 * The unified calendar navigates weeks, months and days without a bound, while
 * the availability read is one bounded civil range — the server refuses a span
 * wider than `ADMIN_AVAILABILITY_MAX_RANGE_DAYS`, so "read everything once" is
 * not a shape the contract allows. The first version of the unified calendar
 * papered over that mismatch by reading a fixed `today … today + 180` window and
 * projecting *every* visible date from it, which meant a week outside those 180
 * days was drawn from an exception list that could not contain its exceptions:
 * a stored closure rendered as ordinary weekly hours, and the grid stated a
 * planning constraint that was not the stored one.
 *
 * Nothing here decides what a date is open for — `dateWindows` still does, and
 * still alone. This module answers the question that has to be settled *before*
 * that one may be asked: does the loaded availability actually cover this date?
 * A projection over an uncovered date is not a slower answer, it is a wrong one,
 * so the calendar waits rather than guessing.
 */
export interface AvailabilityRange {
  readonly fromDate: string;
  readonly untilDate: string;
}

/**
 * How far past the visible span a read reaches when it cannot also reach the
 * editor horizon.
 *
 * Its only job is to keep ordinary paging from re-reading on every step: a
 * month of navigation either way stays inside one window. It is deliberately
 * small compared with the cap, because a wider guess is not more correct — it is
 * only a larger payload for dates nobody is looking at.
 */
export const AVAILABILITY_READ_MARGIN_DAYS = 30;

/**
 * How far ahead the editor's exception list wants to see, independently of where
 * the calendar happens to be pointed. Preserved from the editor's own horizon so
 * that opening the calendar on this week still lists the season ahead.
 */
export const AVAILABILITY_EDITOR_HORIZON_DAYS = 180;

/** Inclusive day count of a civil range, the same count the server applies its cap to. */
export function rangeSpanDays(range: AvailabilityRange): number {
  const from = Date.parse(`${range.fromDate}T12:00:00Z`);
  const until = Date.parse(`${range.untilDate}T12:00:00Z`);
  return Math.round((until - from) / 86_400_000) + 1;
}

/** True when `range` was read wide enough to speak for `localDate`. */
export function rangeCoversDate(range: AvailabilityRange | null, localDate: string): boolean {
  return range !== null && range.fromDate <= localDate && localDate <= range.untilDate;
}

/** True when `range` speaks for every date of `visible`, both bounds included. */
export function rangeCoversSpan(range: AvailabilityRange | null, visible: AvailabilityRange): boolean {
  return rangeCoversDate(range, visible.fromDate) && rangeCoversDate(range, visible.untilDate);
}

/**
 * Whether the visible span forces a fresh read.
 *
 * Only a coverage gap does. Navigating inside the loaded window changes nothing
 * the server would answer differently, and re-reading there would throw away a
 * revision and an exception set that are already current for those dates.
 */
export function needsAvailabilityRead(
  loaded: AvailabilityRange | null,
  visible: AvailabilityRange,
): boolean {
  return !rangeCoversSpan(loaded, visible);
}

/**
 * The range to ask the server for, given what is on screen.
 *
 * Two things want to be in the window and cannot always both fit: the dates
 * being drawn, and the editor's forward horizon that feeds its exception list.
 * The visible span wins, always — it is the one whose absence produces a *wrong*
 * screen rather than a shorter list. So the horizon is folded in whenever the
 * result still fits under the server's cap, and dropped in favour of a margin
 * around the visible span when it does not.
 *
 * The result is never wider than `maxRangeDays`, which is why a calendar pointed
 * two years out still issues a request the server accepts instead of a 400 that
 * would leave the grid with no availability at all.
 */
export function planAvailabilityRange(
  visible: AvailabilityRange,
  today: string,
  maxRangeDays: number = ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
): AvailabilityRange {
  const withHorizon: AvailabilityRange = {
    fromDate: visible.fromDate < today ? visible.fromDate : today,
    untilDate: (() => {
      const horizon = addCivilDays(today, AVAILABILITY_EDITOR_HORIZON_DAYS);
      return visible.untilDate > horizon ? visible.untilDate : horizon;
    })(),
  };
  if (rangeSpanDays(withHorizon) <= maxRangeDays) return withHorizon;

  // The horizon does not fit beside these dates. Keep the visible span whole and
  // spend whatever the cap has left on margin around it, so ordinary paging
  // still does not re-read on every step.
  const spare = Math.max(0, maxRangeDays - rangeSpanDays(visible));
  const margin = Math.min(AVAILABILITY_READ_MARGIN_DAYS, Math.floor(spare / 2));
  return {
    fromDate: addCivilDays(visible.fromDate, -margin),
    untilDate: addCivilDays(visible.untilDate, margin),
  };
}
