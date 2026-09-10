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
  dayAvailabilityLabel,
  isHourOpen,
  shiftWeek,
  startOfWeek,
  weekDays,
  weekHourSpan,
  weekPlan,
} from "../app/lib/admin-calendar-week";
import { toDrafts } from "../app/lib/admin-availability";
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

// --- The unified week (ESZ-159) --------------------------------------------

test("a week is Monday through Sunday, whichever day anchors it", () => {
  // Wednesday 2026-06-17 sits in the week of Monday the 15th.
  assert.equal(startOfWeek("2026-06-17"), "2026-06-15");
  assert.equal(startOfWeek("2026-06-15"), "2026-06-15", "a Monday anchors its own week");
  assert.equal(startOfWeek("2026-06-21"), "2026-06-15", "Sunday belongs to the week that opened");

  assert.deepEqual(weekDays("2026-06-17"), [
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
  ]);

  // Stepping is week-aligned, so paging never drifts onto a mid-week anchor.
  assert.equal(shiftWeek("2026-06-17", 1), "2026-06-22");
  assert.equal(shiftWeek("2026-06-17", -1), "2026-06-08");

  // A week that crosses a month, and one that crosses a year, stay contiguous
  // civil days — the DST boundary included, which is the case a UTC-arithmetic
  // week gets wrong by an hour and therefore by a day.
  assert.deepEqual(weekDays("2026-04-02").slice(0, 2), ["2026-03-30", "2026-03-31"]);
  assert.equal(weekDays("2027-01-01")[0], "2026-12-28");
  assert.deepEqual(weekDays("2026-10-25")[0], "2026-10-19");
});

test("the week's hour span covers every window and every appointment in it", () => {
  const days = weekDays("2026-06-15");
  const rules = toDrafts([
    {
      id: 1,
      weekdayIso: 1,
      startLocal: "09:00",
      endLocal: "12:00",
      foldUtcOffset: null,
      validFrom: null,
      validUntil: null,
      isActive: true,
    },
  ]);

  // Windows alone set the span, rounded out to whole hours.
  assert.deepEqual(weekHourSpan(days, rules, [], []), { firstHour: 9, lastHour: 12 });

  // An appointment outside the weekly hours widens it rather than being cropped:
  // a booking the operator moved to 07:30 is precisely the row they need to see.
  const early = booking({ startsAtUtc: "2026-06-15T05:30:00.000Z", endsAtUtc: "2026-06-15T06:30:00.000Z" });
  const span = weekHourSpan(days, rules, [], [early]);
  assert.equal(span.firstHour, 7, "07:30 Paris must pull the span open to 07:00");
  assert.equal(span.lastHour, 12);

  // An empty week still has a grid to draw.
  assert.deepEqual(weekHourSpan(days, [], [], []), { firstHour: 8, lastHour: 19 });
});

test("an hour is open only while a window actually covers it", () => {
  const windows = [{ startLocal: "09:00", endLocal: "12:00" }];
  assert.equal(isHourOpen(8, windows), false, "the hour before opening is closed");
  assert.equal(isHourOpen(9, windows), true);
  assert.equal(isHourOpen(11, windows), true);
  assert.equal(isHourOpen(12, windows), false, "an exclusive end must not light its own hour");
  assert.equal(isHourOpen(10, []), false, "a closed day has no open hour");

  // A window that starts mid-hour still lights the hour it starts in.
  assert.equal(isHourOpen(9, [{ startLocal: "09:30", endLocal: "10:00" }]), true);
});

test("the week projects appointments and availability from one shared truth", () => {
  const rules = toDrafts([
    {
      id: 1,
      weekdayIso: 1,
      startLocal: "09:00",
      endLocal: "12:00",
      foldUtcOffset: null,
      validFrom: null,
      validUntil: null,
      isActive: true,
    },
  ]);
  const monday = booking({ startsAtUtc: "2026-06-15T07:30:00.000Z", endsAtUtc: "2026-06-15T09:00:00.000Z" });
  const cancelled = booking({
    reference: "bk_cccccccccccccccccccccccccccccccc",
    startsAtUtc: "2026-06-15T08:00:00.000Z",
    endsAtUtc: "2026-06-15T08:30:00.000Z",
    state: "cancelled",
  });

  const plan = weekPlan(weekDays("2026-06-15"), rules, [], [monday, cancelled], "2026-06-16");

  assert.equal(plan.length, 7);
  assert.equal(plan[0].date, "2026-06-15");
  assert.equal(plan[0].kind, "weekly");
  assert.deepEqual(plan[0].windows, [{ startLocal: "09:00", endLocal: "12:00" }]);
  assert.equal(plan[0].isToday, false);
  assert.equal(plan[1].isToday, true, "today is marked from the Paris civil date, not from the host clock");

  // Both appointments are projected: a cancellation stays visible in the
  // calendar, which is the guarantee the day view already made.
  assert.equal(plan[0].appointments.length, 2);
  assert.equal(plan[0].appointments[0].startLocal, "09:30");
  assert.equal(plan[0].appointments[0].endLocal, "11:00");
  assert.equal(plan[0].appointments[0].hour, 9, "09:30 belongs to the 09:00 row");
  assert.equal(plan[0].appointments[0].span, 2, "an appointment crossing an hour spans both");
  assert.equal(plan[0].appointments[1].booking.state, "cancelled");

  // Tuesday has no rule, so it is closed — and a closed day carries no windows
  // rather than an empty-but-open contradiction.
  assert.equal(plan[1].kind, "closed");
  assert.deepEqual(plan[1].windows, []);
  assert.deepEqual(plan[1].appointments, []);

  // A date exception replaces the weekly hours instead of adding to them, and
  // the week reports it as exceptional so the grid can say so.
  const excepted = weekPlan(
    weekDays("2026-06-15"),
    rules,
    [{ id: 1, localDate: "2026-06-15", kind: "open", windows: [{ startLocal: "14:00", endLocal: "16:00", foldUtcOffset: null }], note: null }],
    [],
    "2026-06-15",
  );
  assert.equal(excepted[0].kind, "exception");
  assert.deepEqual(excepted[0].windows, [{ startLocal: "14:00", endLocal: "16:00" }]);
});

test("a day column announces its availability in the words the editor uses", () => {
  const [closed, weekly, exceptional] = [
    { kind: "closed" as const, windows: [] },
    { kind: "weekly" as const, windows: [{ startLocal: "09:00", endLocal: "12:00" }] },
    { kind: "exception" as const, windows: [{ startLocal: "14:00", endLocal: "16:00" }] },
  ].map((availability) => ({ date: "2026-06-15", isToday: false, appointments: [], ...availability }));

  assert.equal(dayAvailabilityLabel(closed), "Fermé");
  assert.equal(dayAvailabilityLabel(weekly), "09:00 – 12:00");
  assert.match(dayAvailabilityLabel(exceptional), /^Exceptionnel : 14:00 – 16:00$/);
});

test("the calendar opens on the week and owns availability without duplicating it", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");

  // Week is the default scale, and all three scales stay reachable.
  assert.match(source, /useState<View>\("week"\)/);
  assert.match(source, /\(\["week", "month", "day"\] as const\)/);
  assert.match(source, /aria-pressed=\{view === candidate\}/);

  // Today / previous / next operate at the scale on screen.
  assert.match(source, /stepView\(-1\)/);
  assert.match(source, /stepView\(1\)/);
  assert.match(source, /goToDate\(today\)/);
  assert.match(source, /Semaine précédente/);
  assert.match(source, /Semaine suivante/);

  // The visible span is the fetched span, at every scale — one walk, never a
  // range the grid is not showing.
  assert.match(source, /loadBookingsRange\(api, dates\[0\], dates\[dates\.length - 1\]\)/);
  assert.match(source, /if \(view === "week"\) return weekDays\(selectedDate\)/);

  // Availability is read through the shared workspace and rendered through the
  // shared projection. No weekday, validity or window rule may be re-decided
  // here: these helpers are the only way the grid learns what a day is open for.
  // ESZ-159 correction: the workspace is read *for the span on screen*, so a
  // week the last read did not cover is never projected from it.
  assert.match(source, /useAvailabilityWorkspace\(visibleSpan\)/);
  assert.equal(source.match(/useAvailabilityWorkspace\(/g)?.length, 1, "one availability state, not two");
  assert.match(source, /fromDate: dates\[0\], untilDate: dates\[dates\.length - 1\]/);
  assert.match(source, /weekPlan\(weekDates, availability\.rules, availability\.exceptions, bookings, today\)/);
  assert.match(source, /isHourOpen\(hour, plan\.windows\)/);
  assert.doesNotMatch(source, /weekdayIso|validFrom|validUntil|isActive/, "no availability rule may be re-derived in the grid");
  assert.doesNotMatch(source, /readAvailability|replaceWeeklyAvailability|mutateAvailabilityException/, "availability I/O belongs to the workspace");

  // Availability is editable from the grid itself, and the editor is the one
  // that already exists rather than a second copy.
  assert.match(source, /editAvailability\(plan\.date\)/);
  assert.match(source, /setShowAvailability\(true\)/);
  assert.match(source, /<AdminAvailabilityEditor workspace=\{availability\} \/>/);
  assert.match(source, /aria-expanded=\{showAvailability\}/);
  assert.match(source, /aria-controls="calendar-availability"/);

  // Opening the calendar reads; it must not write a booking.
  assert.doesNotMatch(source, /mutateBooking\([\s\S]{0,40}action: "move"[\s\S]{0,40}\)\s*;?\s*\}\s*,\s*\[\]/);
  assert.equal(source.match(/api\.mutateBooking/g)?.length, 3, "no fourth booking mutation may appear");

  // Responsive: the week grid scrolls rather than being crushed, and the
  // appointment column keeps its declared desktop width.
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /min-w-\[860px\] grid-cols-\[4\.5rem_repeat\(7,minmax\(0,1fr\)\)\]/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_420px\]/);
  assert.match(source, /aria-busy=\{loading\}/);
});

test("busy is derived from the span that was fetched, not announced by its callers", async () => {
  const source = await readFile(new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url), "utf8");

  assert.match(source, /const loading = loadedRange !== rangeKey/);
  assert.match(source, /setLoadedRange\(rangeKey\)/);
  assert.doesNotMatch(source, /setLoading\(/, "a hand-raised busy flag is what strands a spinner");
});
