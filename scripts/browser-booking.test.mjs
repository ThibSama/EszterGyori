#!/usr/bin/env node
/**
 * ESZ-116 — focused regression proof for the `browser:booking` slot selection.
 *
 * The gate asserts that a booking enqueues a *pending* `booking_reminder` due
 * at `start − 24 h`. Selecting simply the earliest future slot made that
 * assertion depend on the wall clock: a run starting after `start − 24 h` books
 * a slot whose reminder is already past due, `NotificationCatchUpPolicy`
 * terminally skips it — correctly — and the gate fails for a fixture reason.
 *
 * These tests pin the replacement invariant with an explicit `now`, so they are
 * deterministic on any clock and in any runner timezone:
 *
 *   startsAtUtc − 24 h ≥ now + REMINDER_SAFETY_MARGIN_MINUTES
 *
 * Run: `node --test scripts/browser-booking.test.mjs`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  REMINDER_LEAD_MINUTES,
  REMINDER_SAFETY_MARGIN_MINUTES,
  reminderStaysPending,
  selectReminderPendingSlot,
} from "./browser-stack.mjs";

const MINUTE = 60_000;
const SLOT_MINUTES = 15;

const parisTime = (instant) =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(instant)
    .replace(":", ":");

/**
 * One fixture day shaped like the provisioned rules: a 09:00–17:00 Paris window
 * sliced into 15-minute starts. `firstStartUtc` is the day's 09:00 Paris instant
 * stated explicitly in UTC, so no test depends on the host timezone.
 */
function daySlots(localDate, firstStartUtc, windowMinutes = 8 * 60) {
  const first = Date.parse(firstStartUtc);
  const slots = [];
  for (let minute = 0; minute + SLOT_MINUTES <= windowMinutes; minute += SLOT_MINUTES) {
    const startsAt = new Date(first + minute * MINUTE);
    slots.push({
      localDate,
      localStart: parisTime(startsAt),
      startsAtUtc: startsAt.toISOString(),
    });
  }
  return slots;
}

/** What the runner does: earliest qualifying slot over consecutive future days. */
function selectAcrossDays(days, now) {
  for (const slots of days) {
    const chosen = selectReminderPendingSlot(slots, { now });
    if (chosen !== null) return chosen;
  }
  return null;
}

const reminderDueAt = (slot) => Date.parse(slot.startsAtUtc) - REMINDER_LEAD_MINUTES * MINUTE;

// Paris sits at UTC+2 on these September dates: 09:00 Paris = 07:00Z.
const mondayEvening = new Date("2026-09-07T14:50:00.000Z"); // 16:50 Paris, near close
const tuesday = daySlots("2026-09-08", "2026-09-08T07:00:00.000Z");
const wednesday = daySlots("2026-09-09", "2026-09-09T07:00:00.000Z");

test("the margin is an explicit, non-trivial safety budget", () => {
  assert.equal(REMINDER_LEAD_MINUTES, 24 * 60);
  assert.ok(
    REMINDER_SAFETY_MARGIN_MINUTES >= 30,
    `the safety margin must be at least 30 minutes, got ${REMINDER_SAFETY_MARGIN_MINUTES}`,
  );
});

test("weekday evening: the whole next day is rejected and the following day is selected", () => {
  // Every next-morning slot's reminder is already due (or inside the margin).
  for (const slot of tuesday) {
    assert.equal(
      reminderStaysPending(slot.startsAtUtc, mondayEvening),
      false,
      `${slot.startsAtUtc} should have been rejected at ${mondayEvening.toISOString()}`,
    );
  }
  assert.equal(selectReminderPendingSlot(tuesday, { now: mondayEvening }), null);

  const chosen = selectAcrossDays([tuesday, wednesday], mondayEvening);
  assert.equal(chosen.localDate, "2026-09-09");
  assert.equal(chosen.startsAtUtc, "2026-09-09T07:00:00.000Z", "the earliest qualifying slot wins");
  assert.ok(reminderDueAt(chosen) >= mondayEvening.getTime() + REMINDER_SAFETY_MARGIN_MINUTES * MINUTE);
});

test("weekend boundary: a non-bookable day in the middle does not break selection", () => {
  const fridayEvening = new Date("2026-09-11T14:50:00.000Z"); // 16:50 Paris
  const saturday = daySlots("2026-09-12", "2026-09-12T07:00:00.000Z");
  const sunday = []; // the single weekday with no active rule
  const monday = daySlots("2026-09-14", "2026-09-14T07:00:00.000Z");

  assert.equal(selectReminderPendingSlot(saturday, { now: fridayEvening }), null);
  assert.equal(selectReminderPendingSlot(sunday, { now: fridayEvening }), null);

  const chosen = selectAcrossDays([saturday, sunday, monday], fridayEvening);
  assert.equal(chosen.localDate, "2026-09-14");
  assert.equal(chosen.startsAtUtc, "2026-09-14T07:00:00.000Z");
  assert.ok(reminderDueAt(chosen) >= fridayEvening.getTime() + REMINDER_SAFETY_MARGIN_MINUTES * MINUTE);
});

test("a slot whose reminder falls inside the safety margin is rejected", () => {
  const now = new Date("2026-09-07T08:00:00.000Z");
  const at = (offsetMinutes) =>
    new Date(now.getTime() + (REMINDER_LEAD_MINUTES + offsetMinutes) * MINUTE).toISOString();

  // Reminder already due, and reminder due but inside the margin: both refused.
  assert.equal(reminderStaysPending(at(-1), now), false, "a past-due reminder must be refused");
  assert.equal(reminderStaysPending(at(0), now), false, "a reminder due exactly now must be refused");
  assert.equal(
    reminderStaysPending(at(REMINDER_SAFETY_MARGIN_MINUTES - 1), now),
    false,
    "a reminder one minute inside the margin must be refused",
  );
  // Exactly at the margin is the first acceptable instant.
  assert.equal(reminderStaysPending(at(REMINDER_SAFETY_MARGIN_MINUTES), now), true);
  assert.equal(reminderStaysPending(at(REMINDER_SAFETY_MARGIN_MINUTES + 1), now), true);

  const inside = [{ localDate: "2026-09-08", localStart: "x", startsAtUtc: at(REMINDER_SAFETY_MARGIN_MINUTES - 1) }];
  assert.equal(selectReminderPendingSlot(inside, { now }), null);
});

test("whatever the time of day, the selected slot's reminder clears the margin", () => {
  const days = [
    daySlots("2026-09-08", "2026-09-08T07:00:00.000Z"),
    daySlots("2026-09-09", "2026-09-09T07:00:00.000Z"),
    daySlots("2026-09-10", "2026-09-10T07:00:00.000Z"),
    daySlots("2026-09-11", "2026-09-11T07:00:00.000Z"),
  ];
  const base = Date.parse("2026-09-07T00:00:00.000Z");
  let checked = 0;
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    const now = new Date(base + minute * MINUTE);
    const chosen = selectAcrossDays(days, now);
    assert.ok(chosen !== null, `no slot selected at ${now.toISOString()}`);
    assert.ok(
      reminderDueAt(chosen) >= now.getTime() + REMINDER_SAFETY_MARGIN_MINUTES * MINUTE,
      `selected ${chosen.startsAtUtc} at ${now.toISOString()} leaves the reminder inside the margin`,
    );
    checked += 1;
  }
  assert.equal(checked, 144, "every ten-minute instant of a full day was exercised");
});

test("no qualifying slot fails closed rather than falling back", () => {
  const now = new Date("2026-09-07T14:50:00.000Z");
  assert.equal(selectAcrossDays([tuesday], now), null, "a same-window day must not be used as a fallback");
  assert.equal(selectReminderPendingSlot([], { now }), null);
  assert.equal(selectReminderPendingSlot(undefined, { now }), null);
  assert.equal(selectReminderPendingSlot([{ localDate: "2026-09-08" }], { now }), null, "a malformed slot is not selected");
  assert.equal(reminderStaysPending("not-a-timestamp", now), false);
});
