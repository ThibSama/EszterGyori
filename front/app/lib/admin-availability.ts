import { BOOKING_LOCAL_TIME_PATTERN } from "@eszter/contracts";
import type {
  AdminAvailabilityException,
  AdminAvailabilityWindow,
  AdminWeeklyRule,
  AdminWeeklyRuleInput,
} from "./admin-api";

/**
 * The browser half of the availability editor (ESZ-063/064).
 *
 * Everything here is *prevalidation*, and it is worth being explicit about what
 * that means, because the word invites the wrong reading. None of these
 * functions decide anything. The server re-checks every rule in this file, and a
 * set that this module happily accepts is still refused by PHP if PHP disagrees
 * — `availabilityAdminPolicy.clientPrevalidation` in the frozen contract says so
 * in as many words.
 *
 * What they buy is the thing a round trip cannot: telling the operator *which*
 * of eleven rows is the broken one, next to that row, while they are still
 * looking at it. A 400 carrying one opaque message cannot do that, and making
 * the server return per-row paths would be building a second UI inside the API.
 *
 * So the rules are duplicated on purpose, and the duplication is safe in exactly
 * one direction: this module may be *more* permissive than the server without
 * anything breaking, and being stricter only ever costs the operator a rejection
 * they could have appealed by posting the same body directly.
 */

export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export const WEEKDAY_LABELS: Record<number, string> = {
  1: "Lundi",
  2: "Mardi",
  3: "Mercredi",
  4: "Jeudi",
  5: "Vendredi",
  6: "Samedi",
  7: "Dimanche",
};

/** Europe/Paris's two UTC offsets, the only values the fold field may take. */
export const FOLD_OFFSETS = ["+01:00", "+02:00"] as const;
export type FoldOffset = (typeof FOLD_OFFSETS)[number];

/**
 * A weekly rule while it is being edited.
 *
 * `key` is a client-only identity so React can keep a row's focus and its error
 * message attached to it across reorders and deletions. It is never sent: the
 * server assigns ids on the replacement, and a row that has never been saved has
 * no id to send in the first place.
 */
export interface WeeklyRuleDraft {
  key: string;
  weekdayIso: number;
  startLocal: string;
  endLocal: string;
  foldUtcOffset: FoldOffset | null;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
}

export interface RuleIssue {
  index: number;
  field: "weekday" | "window" | "validity" | "overlap";
  message: string;
}

/**
 * Not a second spelling of the clock: the frozen wire pattern itself, which
 * since the range tightening already accepts exactly 00:00–23:59. Copying the
 * alternation here would be the one duplication this module cannot afford,
 * because a client that is stricter than the contract rejects rows the server
 * would have taken.
 */
const LOCAL_TIME = new RegExp(BOOKING_LOCAL_TIME_PATTERN);
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

let nextKey = 0;

export function draftKey(): string {
  nextKey += 1;
  return `rule-${nextKey}`;
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

/** A real calendar date, not merely something shaped like one: 2026-02-30 is not one. */
export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function toDraft(rule: AdminWeeklyRule): WeeklyRuleDraft {
  return {
    key: draftKey(),
    weekdayIso: rule.weekdayIso,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    foldUtcOffset: rule.foldUtcOffset,
    validFrom: rule.validFrom,
    validUntil: rule.validUntil,
    isActive: rule.isActive,
  };
}

export function toDrafts(rules: AdminWeeklyRule[]): WeeklyRuleDraft[] {
  return rules.map(toDraft);
}

export function emptyDraft(weekdayIso: number): WeeklyRuleDraft {
  return {
    key: draftKey(),
    weekdayIso,
    startLocal: "09:00",
    endLocal: "12:00",
    foldUtcOffset: null,
    validFrom: null,
    validUntil: null,
    isActive: true,
  };
}

/** Drops `key`, which is the only difference between a draft and a request rule. */
export function toRequest(drafts: WeeklyRuleDraft[]): AdminWeeklyRuleInput[] {
  return drafts.map((draft) => ({
    weekdayIso: draft.weekdayIso,
    startLocal: draft.startLocal,
    endLocal: draft.endLocal,
    foldUtcOffset: draft.foldUtcOffset,
    validFrom: draft.validFrom,
    validUntil: draft.validUntil,
    isActive: draft.isActive,
  }));
}

/** Display order only. The server stores and returns its own ordering. */
export function sortDrafts(drafts: WeeklyRuleDraft[]): WeeklyRuleDraft[] {
  return [...drafts].sort(
    (left, right) =>
      left.weekdayIso - right.weekdayIso ||
      left.startLocal.localeCompare(right.startLocal) ||
      (left.validFrom ?? "").localeCompare(right.validFrom ?? ""),
  );
}

function timesOverlap(
  left: { startLocal: string; endLocal: string },
  right: { startLocal: string; endLocal: string },
): boolean {
  return left.startLocal < right.endLocal && right.startLocal < left.endLocal;
}

/**
 * Two open-ended validity ranges intersect unless one ends before the other
 * begins. The sentinels match the server's, so "no bound" means the same thing
 * on both sides rather than "excluded from the comparison".
 */
function rangesOverlap(
  left: { validFrom: string | null; validUntil: string | null },
  right: { validFrom: string | null; validUntil: string | null },
): boolean {
  const leftFrom = left.validFrom ?? "0000-01-01";
  const leftUntil = left.validUntil ?? "9999-12-31";
  const rightFrom = right.validFrom ?? "0000-01-01";
  const rightUntil = right.validUntil ?? "9999-12-31";
  return leftFrom <= rightUntil && rightFrom <= leftUntil;
}

/**
 * Every reason the server would refuse this set, attributed to the row that
 * caused it.
 *
 * Overlaps are reported against the *later* of the two rows, so a set with one
 * bad addition blames the addition rather than the rule that was already there.
 */
export function weeklyRuleIssues(rules: WeeklyRuleDraft[]): RuleIssue[] {
  const issues: RuleIssue[] = [];

  rules.forEach((rule, index) => {
    if (!ISO_WEEKDAYS.includes(rule.weekdayIso as (typeof ISO_WEEKDAYS)[number])) {
      issues.push({ index, field: "weekday", message: "Choisissez un jour de la semaine." });
    }
    if (!isLocalTime(rule.startLocal) || !isLocalTime(rule.endLocal)) {
      issues.push({
        index,
        field: "window",
        message: "Indiquez des heures valides au format HH:MM.",
      });
    } else if (rule.endLocal <= rule.startLocal) {
      issues.push({
        index,
        field: "window",
        message: "L’heure de fin doit être postérieure à l’heure de début.",
      });
    }
    for (const bound of [rule.validFrom, rule.validUntil]) {
      if (bound !== null && !isLocalDate(bound)) {
        issues.push({ index, field: "validity", message: "La date de validité est invalide." });
      }
    }
    if (
      rule.validFrom !== null &&
      rule.validUntil !== null &&
      isLocalDate(rule.validFrom) &&
      isLocalDate(rule.validUntil) &&
      rule.validUntil < rule.validFrom
    ) {
      issues.push({
        index,
        field: "validity",
        message: "La fin de validité ne peut pas précéder son début.",
      });
    }
  });

  rules.forEach((rule, index) => {
    for (let earlier = 0; earlier < index; earlier += 1) {
      const other = rules[earlier];
      if (
        other.weekdayIso === rule.weekdayIso &&
        rangesOverlap(other, rule) &&
        timesOverlap(other, rule)
      ) {
        issues.push({
          index,
          field: "overlap",
          message: `Ce créneau chevauche un autre créneau du ${WEEKDAY_LABELS[rule.weekdayIso] ?? ""} sur une même période de validité.`,
        });
        break;
      }
    }
  });

  return issues;
}

export function issuesFor(issues: RuleIssue[], index: number): RuleIssue[] {
  return issues.filter((issue) => issue.index === index);
}

/** The same checks for one date exception's window set, which has no weekday or validity. */
export function exceptionWindowIssues(windows: AdminAvailabilityWindow[]): RuleIssue[] {
  const issues: RuleIssue[] = [];

  windows.forEach((window, index) => {
    if (!isLocalTime(window.startLocal) || !isLocalTime(window.endLocal)) {
      issues.push({
        index,
        field: "window",
        message: "Indiquez des heures valides au format HH:MM.",
      });
      return;
    }
    if (window.endLocal <= window.startLocal) {
      issues.push({
        index,
        field: "window",
        message: "L’heure de fin doit être postérieure à l’heure de début.",
      });
      return;
    }
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (timesOverlap(windows[earlier], window)) {
        issues.push({
          index,
          field: "overlap",
          message: "Cette plage chevauche une autre plage de la même journée.",
        });
        break;
      }
    }
  });

  return issues;
}

export function exceptionForDate(
  exceptions: AdminAvailabilityException[],
  localDate: string,
): AdminAvailabilityException | null {
  return exceptions.find((exception) => exception.localDate === localDate) ?? null;
}

/**
 * Applies one server-returned exception to the list held on screen.
 *
 * `null` is a removal, which is why this takes the date separately: the response
 * that says "this date has no exception any more" carries no date of its own.
 */
export function replaceException(
  exceptions: AdminAvailabilityException[],
  localDate: string,
  next: AdminAvailabilityException | null,
): AdminAvailabilityException[] {
  const without = exceptions.filter((exception) => exception.localDate !== localDate);
  const merged = next === null ? without : [...without, next];
  return merged.sort((left, right) => left.localDate.localeCompare(right.localDate));
}

/**
 * What a date's availability actually is, for the summary line above the editor.
 *
 * The three outcomes are the three the domain has, and "exceptionnellement
 * ouvert" is deliberately not phrased as an addition to the weekly hours: an
 * open exception replaces them outright.
 */
export function describeDate(
  localDate: string,
  rules: WeeklyRuleDraft[],
  exceptions: AdminAvailabilityException[],
): { kind: "closed" | "exception" | "weekly"; windows: string[] } {
  const exception = exceptionForDate(exceptions, localDate);
  if (exception !== null) {
    return {
      kind: exception.kind === "closed" ? "closed" : "exception",
      windows: exception.windows.map((window) => `${window.startLocal} – ${window.endLocal}`),
    };
  }

  const weekday = isoWeekday(localDate);
  const windows = sortDrafts(
    rules.filter(
      (rule) =>
        rule.isActive &&
        rule.weekdayIso === weekday &&
        (rule.validFrom === null || localDate >= rule.validFrom) &&
        (rule.validUntil === null || localDate <= rule.validUntil),
    ),
  ).map((rule) => `${rule.startLocal} – ${rule.endLocal}`);

  return { kind: windows.length === 0 ? "closed" : "weekly", windows };
}

/** ISO weekday (Monday = 1) of a local calendar date, read as a civil date. */
export function isoWeekday(localDate: string): number {
  return new Date(`${localDate}T12:00:00Z`).getUTCDay() || 7;
}
