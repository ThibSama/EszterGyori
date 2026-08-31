import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS,
  ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
  ADMIN_AVAILABILITY_MAX_WEEKLY_RULES,
  ADMIN_SUMMARY_MAX_UPCOMING_DAYS,
  BOOKING_SLOT_MAX_HORIZON_DAYS,
  BOOKING_SLOT_MAX_RESULTS,
} from "@eszter/contracts";

/**
 * ESZ-085 — budgets on the payloads Packages 5.x through 7.x added.
 *
 * ## Why the worst case rather than the typical one
 *
 * The reservation and admin surfaces are the first on this site whose response
 * size depends on *data* rather than on the page. A slot list grows with the
 * horizon, a booking list with the range, a summary with its window — and every
 * one of those is a number a caller supplies. So the interesting size is never
 * the one a developer sees on a site with three bookings; it is the one the
 * contract's own maximum permits, and that is what these tests construct.
 *
 * Each budget is a ratchet, not a target: set above what the current shape
 * produces at its declared maximum, so a field added to a slot or a booking entry
 * shows up here rather than on a phone on a slow connection. A payload that
 * doubles is a change someone should have to justify by editing this file.
 *
 * ## What this does not claim
 *
 * Nothing here is a timing measurement, and none of it involves a browser. There
 * is no browser runner in this repository and `docs/v1-quality-gates.md` keeps the
 * browser gates at NOT RUN; this is arithmetic over payload shapes, which is
 * exactly as much as a Node test can honestly prove.
 */

function bytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function gzippedBytes(payload: unknown): number {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 }).length;
}

function budget(label: string, actual: number, ceiling: number): void {
  assert.ok(
    actual <= ceiling,
    `${label} is ${actual} bytes, over its ${ceiling} byte budget. ` +
      "If the growth is intended, raise the budget in this file in the same commit " +
      "so the increase is reviewed rather than absorbed.",
  );
}

/** One slot, exactly as `bookingAvailabilityResponseSchema` declares it. */
function slot(index: number) {
  const day = String((index % 28) + 1).padStart(2, "0");
  const hour = String((index % 12) + 8).padStart(2, "0");

  return {
    localDate: `2026-08-${day}`,
    localStart: `${hour}:15`,
    foldUtcOffset: null,
    startsAtUtc: `2026-08-${day}T${hour}:15:00.000Z`,
    endsAtUtc: `2026-08-${day}T${hour}:45:00.000Z`,
  };
}

/** One admin booking entry, with every optional customer field populated. */
function booking(index: number) {
  return {
    reference: `bk_${index.toString(16).padStart(32, "0")}`,
    serviceKey: "brows",
    state: "confirmed",
    startsAtUtc: "2026-08-24T07:15:00.000Z",
    endsAtUtc: "2026-08-24T09:15:00.000Z",
    timezone: "Europe/Paris",
    customerName: "Marie-Christine de la Fontaine-Dupont",
    customerEmail: "marie-christine.delafontaine@example-domain-name.test",
    customerPhone: "+33 6 12 34 56 78",
    customerNote:
      "Première séance. Merci de prévoir un quart d'heure supplémentaire, et de me prévenir en cas de retard.",
    consentAtUtc: "2026-08-01T09:00:00.000Z",
    cancelledAtUtc: null,
    cancellationReason: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

test("the availability response stays bounded at the contract's own maximum", () => {
  // `BOOKING_SLOT_MAX_RESULTS` is the ceiling the slot engine enforces, so this
  // is the largest availability response the API can emit — not a guess at a
  // busy week.
  const response = {
    serviceKey: "brows",
    timezone: "Europe/Paris",
    fromDate: "2026-08-01",
    untilDate: "2026-10-30",
    slots: Array.from({ length: BOOKING_SLOT_MAX_RESULTS }, (_, index) => slot(index)),
  };

  budget("availability at max results (raw)", bytes(response), 200_000);

  // The number that matters to someone on a phone. Slots are extremely
  // repetitive, so the compressed size is a small fraction of the raw one — and
  // it is the compressed size that is transferred.
  budget("availability at max results (gzip)", gzippedBytes(response), 12_000);
});

test("one slot stays small, because the horizon multiplies it", () => {
  // The per-item budget is the one that catches a field being added. At the
  // maximum result count a single extra 40-byte field is 40 kB on the wire, and
  // against the whole-response budget that reads as noise.
  budget("one availability slot", bytes(slot(0)), 160);
});

test("the admin booking list stays bounded across the widest range it accepts", () => {
  // The admin query accepts up to `BOOKING_SLOT_MAX_HORIZON_DAYS`. Four bookings
  // a day across that range is far past this practitioner's capacity and is the
  // right shape for a ceiling.
  const count = BOOKING_SLOT_MAX_HORIZON_DAYS * 4;
  const response = { bookings: Array.from({ length: count }, (_, index) => booking(index)) };

  budget("admin bookings at four per day for 90 days (raw)", bytes(response), 250_000);
  budget("admin bookings at four per day for 90 days (gzip)", gzippedBytes(response), 20_000);
  budget("one admin booking entry", bytes(booking(0)), 700);
});

test("the operations summary stays small regardless of its window", () => {
  const entry = {
    reference: `bk_${"0".repeat(32)}`,
    serviceKey: "brows",
    startsAtUtc: "2026-08-24T07:15:00.000Z",
    endsAtUtc: "2026-08-24T09:15:00.000Z",
    customerName: "Marie-Christine de la Fontaine-Dupont",
  };

  const response = {
    timezone: "Europe/Paris",
    generatedAtUtc: "2026-08-21T09:00:00.000Z",
    upcomingDays: ADMIN_SUMMARY_MAX_UPCOMING_DAYS,
    counts: {
      todayConfirmed: 8,
      todayCancelled: 1,
      upcomingConfirmed: 360,
      upcomingCancelled: 12,
    },
    nextConfirmedStartsAtUtc: "2026-08-24T07:15:00.000Z",
    today: Array.from({ length: 8 }, () => entry),
    upcoming: Array.from({ length: ADMIN_SUMMARY_MAX_UPCOMING_DAYS * 4 }, () => entry),
  };

  budget("operations summary at its maximum window (raw)", bytes(response), 90_000);
  budget("operations summary at its maximum window (gzip)", gzippedBytes(response), 4_000);
});

test("the availability weekly replacement stays bounded at its declared rule ceiling", () => {
  // This one travels as a request rather than a response, so it is also bounded
  // by REQUEST_BODY_LIMIT — and that is the point of measuring it. A weekly set
  // at the contract's maximum has to fit through the 64 kB body guard, or the
  // editor would build a set the server refuses to read.
  const request = {
    rules: Array.from({ length: ADMIN_AVAILABILITY_MAX_WEEKLY_RULES }, (_, index) => ({
      weekdayIso: (index % 7) + 1,
      startLocal: "09:00",
      endLocal: "17:30",
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
      foldUtcOffset: null,
    })),
  };

  const size = bytes(request);

  budget("weekly replacement at max rules", size, 16_000);
  assert.ok(
    size < 64 * 1024,
    "a weekly set at the contract's own maximum must fit through REQUEST_BODY_LIMIT, " +
      "or the editor can build a set the server refuses to read",
  );
});

test("an availability exception stays bounded at its declared window ceiling", () => {
  const request = {
    localDate: "2026-08-24",
    kind: "open",
    windows: Array.from({ length: ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS }, () => ({
      startLocal: "09:00",
      endLocal: "12:30",
      foldUtcOffset: null,
    })),
  };

  budget("availability exception at max windows", bytes(request), 1_200);
});

test("every declared query bound is finite and small enough to be a bound", () => {
  // A bound that is not enforced is not a bound, and a bound so large that no
  // caller could reach it is decoration. These are the five numbers that keep an
  // anonymous caller from asking for an unbounded computation, so they are
  // asserted rather than assumed.
  const bounds: Array<[string, number, number]> = [
    ["slot horizon (days)", BOOKING_SLOT_MAX_HORIZON_DAYS, 366],
    ["slot results", BOOKING_SLOT_MAX_RESULTS, 5_000],
    ["availability query range (days)", ADMIN_AVAILABILITY_MAX_RANGE_DAYS, 1_000],
    ["weekly rules", ADMIN_AVAILABILITY_MAX_WEEKLY_RULES, 500],
    ["exception windows", ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS, 50],
    ["summary window (days)", ADMIN_SUMMARY_MAX_UPCOMING_DAYS, 366],
  ];

  for (const [label, value, ceiling] of bounds) {
    assert.ok(Number.isInteger(value) && value > 0, `${label} is not a positive integer`);
    assert.ok(value <= ceiling, `${label} is ${value}, too large to bound anything`);
  }
});
