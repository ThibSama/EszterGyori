import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
  ADMIN_BOOKINGS_PATH,
  ADMIN_BOOKINGS_QUERY_PATH,
  BOOKING_ADMIN_RANGE_MAX_PAGES,
  BOOKING_ADMIN_RANGE_PAGE_SIZE,
  CSRF_HEADER,
} from "@eszter/contracts";
import {
  createAdminApiClient,
  loadBookingsRange,
  type AdminBooking,
} from "../app/lib/admin-api";
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
    customerPhone: "+331****0405",
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

function page(
  bookings: AdminBooking[],
  hasMore: boolean,
  nextCursor: { startsAtUtc: string; reference: string } | null = null,
) {
  return {
    bookings,
    page: {
      pageSize: BOOKING_ADMIN_RANGE_PAGE_SIZE,
      hasMore,
      nextCursor,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
  const responses = [page([booking()], false), availability, { booking: booking({ startsAtUtc: availability.slots[0].startsAtUtc }) }];
  let index = 0;
  const api = createAdminApiClient(async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(responses[index++]), { status: 200, headers: { "content-type": "application/json" } });
  });
  await api.queryBookings({ mode: "range", fromDate: "2026-10-01", untilDate: "2026-10-31" });
  await api.moveAvailability({ reference: REFERENCE, fromDate: "2026-10-25", untilDate: "2026-10-25" });
  await api.mutateBooking(
    { action: "move", reference: REFERENCE, expectedUpdatedAt: booking().updatedAt, startsAtUtc: availability.slots[0].startsAtUtc },
    "csrf-token",
  );

  assert.deepEqual(calls.map((call) => call.path), [ADMIN_BOOKINGS_QUERY_PATH, ADMIN_BOOKING_MOVE_AVAILABILITY_PATH, ADMIN_BOOKINGS_PATH]);
  assert.equal(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[1]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[2]?.init?.headers).get(CSRF_HEADER), "csrf-token");
  assert.equal(JSON.parse(String(calls[2]?.init?.body)).startsAtUtc, availability.slots[0].startsAtUtc);
  // ESZ-139: the mutation carries the booking's own updatedAt as its
  // optimistic-concurrency token, byte-for-byte from the read that seeded it.
  assert.equal(JSON.parse(String(calls[2]?.init?.body)).expectedUpdatedAt, "2026-08-20T10:00:00.000Z");
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

test("calendar mutations send the booking token and never auto-retry a stale conflict", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");

  // ESZ-139: every mutation (move, cancel, update) sends the selected
  // booking's own updatedAt as expectedUpdatedAt — three payload sites, and
  // no fourth mutateBooking call exists anywhere (a stale 409 must never
  // auto-retry).
  assert.equal(source.match(/expectedUpdatedAt: selected\.updatedAt/g)?.length, 3);
  assert.equal(source.match(/api\.mutateBooking/g)?.length, 3, "a stale 409 must never auto-retry a mutation");

  // The move flow tells the two frozen 409 codes apart: a REVISION_CONFLICT
  // reloads the booking and shows explicit stale-data copy, while a genuinely
  // unavailable slot keeps its own copy. Either way slots are refreshed only
  // when the reloaded booking is still confirmed.
  assert.match(source, /result\.failure\.kind !== "conflict"/);
  assert.match(source, /result\.failure\.errorCode === "REVISION_CONFLICT"/);
  assert.match(source, /const fresh = await refreshOne\(selected\.reference\)/);
  assert.match(source, /if \(fresh\?\.state === "confirmed"\) \{\s*\n\s*await loadMoveSlots\(fresh, moveDate\);/);
  assert.match(source, /Ce rendez-vous avait déjà changé\. Il n’a pas été déplacé : les données affichées ont été actualisées\./);
  assert.match(source, /Ce créneau n’est plus disponible\. Le rendez-vous n’a pas été déplacé/);

  // Cancel and update conflicts reload by reference and never claim success.
  assert.match(source, /Il n’a pas été annulé : les données affichées ont été actualisées\./);
  assert.match(source, /sans enregistrer la modification\./);
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

test("the calendar loads one month as one complete paginated walk", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");
  assert.match(source, /loadBookingsRange\(api, dates\[0\], dates\[dates\.length - 1\]\)/);
  assert.match(source, /setBookings\(result\.value\)/);
  assert.match(source, /Chargement des rendez-vous…/);
});

test("a range load walks every page with typed cursors and stops when hasMore clears", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const first = booking({ reference: "bk_11111111111111111111111111111111", startsAtUtc: "2026-10-05T07:00:00.000Z" });
  const second = booking({ reference: "bk_22222222222222222222222222222222", startsAtUtc: "2026-10-05T07:30:00.000Z" });
  const third = booking({ reference: "bk_33333333333333333333333333333333", startsAtUtc: "2026-10-05T08:00:00.000Z" });
  const cursorOne = { startsAtUtc: first.startsAtUtc, reference: first.reference };
  const cursorTwo = { startsAtUtc: second.startsAtUtc, reference: second.reference };
  const api = createAdminApiClient(async (_path, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (sent.length === 1) return jsonResponse(page([first], true, cursorOne));
    if (sent.length === 2) return jsonResponse(page([second], true, cursorTwo));
    return jsonResponse(page([third], false));
  });

  const result = await loadBookingsRange(api, "2026-10-01", "2026-10-31");

  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((item) => item.reference),
    [first.reference, second.reference, third.reference],
  );
  // Three requests: the first carries no cursor at all, the next two echo the
  // server's typed cursors verbatim.
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], { mode: "range", fromDate: "2026-10-01", untilDate: "2026-10-31" });
  assert.deepEqual(sent[1].cursor, cursorOne);
  assert.deepEqual(sent[2].cursor, cursorTwo);
});

test("a repeated cursor is refused as malformed rather than followed into a loop", async () => {
  let calls = 0;
  const cursor = { startsAtUtc: "2026-10-05T07:00:00.000Z", reference: "bk_11111111111111111111111111111111" };
  const api = createAdminApiClient(async () => {
    calls += 1;
    return jsonResponse(page([booking()], true, cursor));
  });

  const result = await loadBookingsRange(api, "2026-10-01", "2026-10-31");

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "malformed-response");
  assert.equal(calls, 2, "a non-advancing cursor must stop the walk at once");
});

test("a page that claims hasMore without a cursor is refused as malformed", async () => {
  const api = createAdminApiClient(async () => jsonResponse(page([booking()], true, null)));
  const result = await loadBookingsRange(api, "2026-10-01", "2026-10-31");
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "malformed-response");
});

test("an empty page means the range is exhausted, and only then", async () => {
  const done = createAdminApiClient(async () => jsonResponse(page([], false)));
  const empty = await loadBookingsRange(done, "2026-10-01", "2026-10-31");
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, []);

  const lying = createAdminApiClient(async () => jsonResponse(page([], true)));
  const refused = await loadBookingsRange(lying, "2026-10-01", "2026-10-31");
  assert.ok(!refused.ok);
  assert.equal(refused.failure.kind, "malformed-response");
});

test("a range load that exhausts the declared page budget fails as incomplete, not silently", async () => {
  let calls = 0;
  const api = createAdminApiClient(async () => {
    calls += 1;
    const reference = `bk_${String(calls).padStart(32, "0")}`;
    return jsonResponse(
      page(
        [booking({ reference, startsAtUtc: "2026-10-05T07:00:00.000Z" })],
        true,
        { startsAtUtc: "2026-10-05T07:00:00.000Z", reference },
      ),
    );
  });

  const result = await loadBookingsRange(api, "2026-10-01", "2026-10-31");

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "range-incomplete");
  assert.match(result.failure.message, /sans garantir qu’ils sont tous là/);
  assert.equal(calls, BOOKING_ADMIN_RANGE_MAX_PAGES, "the walk must stop at the declared budget");
});

test("a range page whose body breaks the frozen schema is never handed to the calendar", async () => {
  // No `page` envelope: the response schema is strict, so this is malformed
  // even though the bookings array alone would have parsed before ESZ-144.
  const api = createAdminApiClient(async () => jsonResponse({ bookings: [booking()] }));
  const result = await loadBookingsRange(api, "2026-10-01", "2026-10-31");
  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "malformed-response");
});
