import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
  ADMIN_BOOKINGS_PATH,
  ADMIN_BOOKINGS_QUERY_PATH,
  CSRF_HEADER,
} from "@eszter/contracts";
import { createAdminApiClient, type AdminBooking } from "../app/lib/admin-api";
import {
  bookingsForDate,
  formatParisTime,
  monthGrid,
  parisLocalDate,
  replaceBooking,
  shiftMonth,
} from "../app/lib/admin-booking-calendar";

const REFERENCE = "bk_00000000000000000000000000000000";

function booking(overrides: Partial<AdminBooking> = {}): AdminBooking {
  return {
    reference: REFERENCE,
    serviceKey: "brows",
    state: "confirmed",
    startsAtUtc: "2026-10-25T01:30:00.000Z",
    endsAtUtc: "2026-10-25T02:00:00.000Z",
    timezone: "Europe/Paris",
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: "+33102030405",
    customerNote: "Note",
    consentAtUtc: "2026-08-20T10:00:00.000Z",
    cancelledAtUtc: null,
    cancellationReason: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    history: [{ type: "created", actor: "public", occurredAt: "2026-08-20T10:00:00.000Z" }],
    ...overrides,
  };
}

test("calendar civil arithmetic and rendering are explicitly Paris-local", () => {
  assert.equal(parisLocalDate("2026-03-29T22:30:00.000Z"), "2026-03-30");
  assert.equal(formatParisTime("2026-10-25T01:30:00.000Z"), "02:30");
  assert.equal(monthGrid("2026-08").length, 42);
  assert.equal(monthGrid("2026-08")[0], "2026-07-27");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
});

test("day grouping is deterministic and server state is replaced, never derived", () => {
  const later = booking({ reference: "bk_11111111111111111111111111111111", startsAtUtc: "2026-10-25T02:30:00.000Z" });
  const cancelled = booking({ state: "cancelled", cancelledAtUtc: "2026-08-21T10:00:00.000Z" });
  assert.deepEqual(bookingsForDate([later, cancelled], "2026-10-25").map((item) => item.reference), [REFERENCE, later.reference]);
  assert.equal(replaceBooking([booking()], cancelled)[0]?.state, "cancelled");
});

test("admin booking transport uses authenticated read routes and CSRF only on mutation", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const availability = {
    serviceKey: "brows",
    timezone: "Europe/Paris",
    fromDate: "2026-10-25",
    untilDate: "2026-10-25",
    slots: [{ localDate: "2026-10-25", localStart: "10:00", foldUtcOffset: null, startsAtUtc: "2026-10-25T09:00:00.000Z", endsAtUtc: "2026-10-25T09:30:00.000Z" }],
  };
  const responses = [{ bookings: [booking()] }, availability, { booking: booking({ startsAtUtc: availability.slots[0].startsAtUtc }) }];
  let index = 0;
  const api = createAdminApiClient(async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(responses[index++]), { status: 200, headers: { "content-type": "application/json" } });
  });
  await api.queryBookings({ mode: "range", fromDate: "2026-10-01", untilDate: "2026-10-31" });
  await api.moveAvailability({ reference: REFERENCE, fromDate: "2026-10-25", untilDate: "2026-10-25" });
  await api.mutateBooking({ action: "move", reference: REFERENCE, startsAtUtc: availability.slots[0].startsAtUtc }, "csrf-token");

  assert.deepEqual(calls.map((call) => call.path), [ADMIN_BOOKINGS_QUERY_PATH, ADMIN_BOOKING_MOVE_AVAILABILITY_PATH, ADMIN_BOOKINGS_PATH]);
  assert.equal(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[1]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[2]?.init?.headers).get(CSRF_HEADER), "csrf-token");
  assert.equal(JSON.parse(String(calls[2]?.init?.body)).startsAtUtc, availability.slots[0].startsAtUtc);
});

test("calendar UI keeps conflict, cancellation, focus and responsive guarantees explicit", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");
  // ESZ-085 replaced the month view's ARIA grid with a labelled list. The roles
  // were applied with no row role between the container and its cells, which is
  // not a grid, and the grid role additionally promises arrow-key navigation this
  // component does not implement. What this assertion cared about — that the month
  // view is an announced structure rather than an anonymous pile of buttons — is
  // now carried by the list role and by each day's own accessible name, and
  // `accessibility.test.ts` asserts both.
  assert.match(source, /role="list" aria-label="Calendrier mensuel"/);
  assert.match(source, /aria-pressed=\{view === candidate\}/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_420px\]/);
  assert.match(source, /detailHeadingRef\.current\?\.focus/);
  assert.match(source, /markExpired\(\)/);
  assert.match(source, /refreshSession\(\)/);
  assert.match(source, /setSelectedSlot\(null\)/);
  assert.match(source, /Le rendez-vous n’a pas été déplacé/);
  assert.match(source, /Confirmer l’annulation/);
  assert.match(source, /Il reste visible dans le calendrier/);
});

test("calendar UI exposes contract-validated contact editing without deriving server state", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");

  assert.match(source, /Modifier les coordonnées/);
  for (const id of ["contact-name", "contact-email", "contact-phone", "contact-note"]) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  assert.match(source, /Enregistrer les coordonnées/);
  assert.match(source, /Annuler la modification/);
  assert.match(source, /selected\.customerPhone &&/);
  assert.match(source, /selected\.customerNote &&/);
  assert.match(source, /setContactPhone\(selected\.customerPhone \?\? ""\)/);
  assert.match(source, /setContactNote\(selected\.customerNote \?\? ""\)/);
  assert.match(source, /adminBookingMutationRequestSchema\.safeParse/);
  assert.match(source, /setBookings\(\(current\) => replaceBooking\(current, result\.value\)\)/);
  assert.match(source, /setMessage\("Les coordonnées du rendez-vous ont été enregistrées\."\)/);
  assert.match(source, /onClick=\{\(\) => \{ setAction\("none"\); setContactErrors\(\{\}\); \}\}/);
  assert.match(source, /if \(!parsed\.success\)[\s\S]*setContactErrors\(errors\)[\s\S]*document\.getElementById/);
  assert.match(source, /tabIndex=\{-1\}[\s\S]*contact-name-error/);
  assert.match(source, /ref=\{noticeRef\} tabIndex=\{-1\}/);
  const cancelEdit = source.match(/onClick=\{\(\) => \{ setAction\("none"\); setContactErrors\(\{\}\); \}\}[\s\S]*?Annuler la modification/);
  assert.ok(cancelEdit);
  assert.doesNotMatch(cancelEdit[0], /setBookings/);
  assert.match(source, /result\.failure\.kind === "conflict"[\s\S]*refreshOne\(selected\.reference\)[\s\S]*setAction\("none"\)/);
});
