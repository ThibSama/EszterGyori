import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
  ADMIN_AVAILABILITY_QUERY_PATH,
  ADMIN_AVAILABILITY_WEEKLY_PATH,
  ADMIN_BOOKINGS_SUMMARY_PATH,
  BOOKING_LOCAL_TIME_PATTERN,
  CSRF_HEADER,
} from "@eszter/contracts";
import {
  createAdminApiClient,
  type AdminAvailabilityException,
  type AdminWeeklyRule,
} from "../app/lib/admin-api";
import {
  describeDate,
  exceptionForDate,
  exceptionWindowIssues,
  isLocalDate,
  isLocalTime,
  isoWeekday,
  replaceException,
  sortDrafts,
  toDrafts,
  toRequest,
  weeklyRuleIssues,
  type WeeklyRuleDraft,
} from "../app/lib/admin-availability";

function rule(overrides: Partial<AdminWeeklyRule> = {}): AdminWeeklyRule {
  return {
    id: 1,
    weekdayIso: 1,
    startLocal: "09:00",
    endLocal: "12:00",
    foldUtcOffset: null,
    validFrom: null,
    validUntil: null,
    isActive: true,
    ...overrides,
  };
}

function draft(overrides: Partial<WeeklyRuleDraft> = {}): WeeklyRuleDraft {
  return { key: `k-${Math.random()}`, ...rule(), ...overrides } as WeeklyRuleDraft;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- ESZ-063 / ESZ-064: the transport -------------------------------------

test("availability reads carry no CSRF and mutations carry it on the frozen paths", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const responses = [
    { timezone: "Europe/Paris", fromDate: "2026-06-01", untilDate: "2026-06-30", weeklyRules: [rule()], exceptions: [] },
    { timezone: "Europe/Paris", weeklyRules: [rule({ id: 7 })] },
    { exception: { id: 3, localDate: "2026-06-15", kind: "closed", windows: [], note: null } },
    {
      timezone: "Europe/Paris",
      todayDate: "2026-06-13",
      untilDate: "2026-06-19",
      upcomingDays: 7,
      counts: { todayConfirmed: 0, todayCancelled: 0, upcomingConfirmed: 0, upcomingCancelled: 0 },
      nextConfirmedStartsAtUtc: null,
      today: [],
      upcoming: [],
    },
  ];
  let index = 0;
  const api = createAdminApiClient(async (path, init) => {
    calls.push({ path, init });
    return jsonResponse(responses[index++]);
  });

  await api.readAvailability({ fromDate: "2026-06-01", untilDate: "2026-06-30" });
  const weekly = await api.replaceWeeklyAvailability(
    { rules: toRequest([draft()]) },
    "csrf-token",
  );
  await api.mutateAvailabilityException(
    { action: "close", localDate: "2026-06-15", note: null },
    "csrf-token",
  );
  await api.bookingsSummary({ upcomingDays: 7 });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      ADMIN_AVAILABILITY_QUERY_PATH,
      ADMIN_AVAILABILITY_WEEKLY_PATH,
      ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      ADMIN_BOOKINGS_SUMMARY_PATH,
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.init?.method),
    ["POST", "PUT", "PATCH", "POST"],
  );

  // The two reads must not send a token, and the two mutations must.
  assert.equal(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[3]?.init?.headers).get(CSRF_HEADER), null);
  assert.equal(new Headers(calls[1]?.init?.headers).get(CSRF_HEADER), "csrf-token");
  assert.equal(new Headers(calls[2]?.init?.headers).get(CSRF_HEADER), "csrf-token");

  // The whole set goes in one body: that is what makes the replacement atomic.
  const sent = JSON.parse(String(calls[1]?.init?.body));
  assert.equal(Object.keys(sent).length, 1);
  assert.equal(sent.rules.length, 1);
  assert.ok(!("id" in sent.rules[0]), "a client-side id was sent for a replaced rule");

  // And the caller is handed the server's rules, not its own.
  assert.ok(weekly.ok);
  assert.equal(weekly.value[0].id, 7);
});

test("a removal resolves with null rather than with an invented exception", async () => {
  const api = createAdminApiClient(async () => jsonResponse({ exception: null }));
  const result = await api.mutateAvailabilityException(
    { action: "remove", localDate: "2026-06-15" },
    "csrf-token",
  );

  assert.ok(result.ok);
  assert.equal(result.value, null);
});

test("a 2xx whose body breaks the frozen schema is never handed to the editor", async () => {
  // `weekdayIso: 0` breaks the schema itself — and since the range tightening so
  // would `startLocal: "25:00"`, because the frozen wire pattern now spells the
  // clock. What stays a domain rule the server enforces is everything the range
  // cannot express: an increasing window, a wall time that exists on that date.
  const api = createAdminApiClient(async () =>
    jsonResponse({ timezone: "Europe/Paris", weeklyRules: [{ ...rule(), weekdayIso: 0 }] }),
  );
  const result = await api.replaceWeeklyAvailability({ rules: [] }, "csrf-token");

  assert.ok(!result.ok);
  assert.equal(result.failure.kind, "malformed-response");
});

test("an expired session and a refused schedule are different failures", async () => {
  const unauthenticated = createAdminApiClient(async () =>
    jsonResponse(
      { error: { code: "UNAUTHENTICATED", message: "x", requestId: "req_1" } },
      401,
    ),
  );
  const refused = createAdminApiClient(async () =>
    jsonResponse(
      { error: { code: "VALIDATION_FAILED", message: "x", requestId: "req_2" } },
      400,
    ),
  );
  const stale = createAdminApiClient(async () =>
    jsonResponse(
      { error: { code: "CSRF_TOKEN_INVALID", message: "x", requestId: "req_3" } },
      403,
    ),
  );

  const expired = await unauthenticated.readAvailability({
    fromDate: "2026-06-01",
    untilDate: "2026-06-30",
  });
  assert.ok(!expired.ok);
  assert.equal(expired.failure.kind, "unauthenticated");

  const rejected = await refused.replaceWeeklyAvailability({ rules: [] }, "csrf-token");
  assert.ok(!rejected.ok);
  assert.equal(rejected.failure.kind, "validation");

  const forbidden = await stale.mutateAvailabilityException(
    { action: "remove", localDate: "2026-06-15" },
    "csrf-token",
  );
  assert.ok(!forbidden.ok);
  assert.equal(forbidden.failure.kind, "forbidden");
});

// --- ESZ-063: weekly prevalidation ----------------------------------------

test("local time and date guards reject shapes and impossible calendar values", () => {
  for (const good of ["00:00", "00:01", "09:30", "23:00", "23:59"]) {
    assert.ok(isLocalTime(good), good);
  }
  // 24:00 and 25:00 are the two the loose `\d{2}:\d{2}` used to admit; the rest
  // are the shapes that were always refused.
  for (const bad of ["24:00", "25:00", "09:60", "99:99", "9:30", "09:00:00", ""]) {
    assert.ok(!isLocalTime(bad), bad);
  }

  // The guard is the contract's own pattern, not a copy of it. A client stricter
  // than the server would refuse rows the server would have accepted.
  assert.equal(BOOKING_LOCAL_TIME_PATTERN, "^([01][0-9]|2[0-3]):[0-5][0-9]$");
  for (const value of ["00:00", "23:59", "24:00", "25:00", "09:60"]) {
    assert.equal(
      isLocalTime(value),
      new RegExp(BOOKING_LOCAL_TIME_PATTERN).test(value),
      value,
    );
  }

  assert.ok(isLocalDate("2026-02-28"));
  assert.ok(isLocalDate("2028-02-29"));
  assert.ok(!isLocalDate("2026-02-30"), "a date that does not exist was accepted");
  assert.ok(!isLocalDate("2026-13-01"));
  assert.ok(!isLocalDate("2026-6-1"));
});

test("weekly prevalidation names the offending row for every rule the server enforces", () => {
  const inverted = weeklyRuleIssues([draft({ startLocal: "18:00", endLocal: "09:00" })]);
  assert.deepEqual(inverted.map((issue) => issue.field), ["window"]);
  assert.match(inverted[0].message, /postérieure/);

  assert.deepEqual(
    weeklyRuleIssues([draft({ startLocal: "09:00", endLocal: "09:00" })]).map((i) => i.field),
    ["window"],
    "an empty window was accepted",
  );

  assert.deepEqual(
    weeklyRuleIssues([draft({ validFrom: "2026-12-31", validUntil: "2026-01-01" })]).map(
      (i) => i.field,
    ),
    ["validity"],
  );
  assert.deepEqual(
    weeklyRuleIssues([draft({ validFrom: "2026-02-30" })]).map((i) => i.field),
    ["validity"],
  );
  assert.deepEqual(
    weeklyRuleIssues([draft({ weekdayIso: 8 })]).map((i) => i.field),
    ["weekday"],
  );
});

test("overlap prevalidation follows the validity ranges and blames the later row", () => {
  const overlapping = weeklyRuleIssues([
    draft({ startLocal: "09:00", endLocal: "12:00" }),
    draft({ startLocal: "11:00", endLocal: "13:00" }),
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].index, 1, "the overlap was blamed on the pre-existing row");
  assert.equal(overlapping[0].field, "overlap");

  // Touching boundaries are not an overlap: 09:00-12:00 and 12:00-15:00 fit.
  assert.deepEqual(
    weeklyRuleIssues([
      draft({ startLocal: "09:00", endLocal: "12:00" }),
      draft({ startLocal: "12:00", endLocal: "15:00" }),
    ]),
    [],
  );

  // Same window, different weekday: unrelated.
  assert.deepEqual(
    weeklyRuleIssues([draft({ weekdayIso: 1 }), draft({ weekdayIso: 2 })]),
    [],
  );

  // Same window and weekday, but validity ranges that do not intersect.
  assert.deepEqual(
    weeklyRuleIssues([
      draft({ validFrom: null, validUntil: "2026-06-30" }),
      draft({ validFrom: "2026-07-01", validUntil: null }),
    ]),
    [],
  );

  // Ranges that do intersect, including through an open bound.
  assert.equal(
    weeklyRuleIssues([
      draft({ validFrom: null, validUntil: null }),
      draft({ validFrom: "2026-07-01", validUntil: "2026-07-31" }),
    ]).length,
    1,
    "an open-ended range was treated as intersecting nothing",
  );
});

test("drafts round-trip to request rules without carrying a client id", () => {
  const drafts = toDrafts([rule({ id: 4 }), rule({ id: 9, weekdayIso: 3 })]);
  assert.equal(drafts.length, 2);
  assert.notEqual(drafts[0].key, drafts[1].key, "two rows shared a React key");

  const request = toRequest(drafts);
  for (const sent of request) {
    assert.ok(!("id" in sent));
    assert.ok(!("key" in sent));
  }
  assert.deepEqual(Object.keys(request[0]).sort(), [
    "endLocal",
    "foldUtcOffset",
    "isActive",
    "startLocal",
    "validFrom",
    "validUntil",
    "weekdayIso",
  ]);
});

test("display sorting is by weekday then start then validity start", () => {
  const sorted = sortDrafts([
    draft({ weekdayIso: 3, startLocal: "09:00" }),
    draft({ weekdayIso: 1, startLocal: "14:00" }),
    draft({ weekdayIso: 1, startLocal: "09:00", validFrom: "2026-07-01" }),
    draft({ weekdayIso: 1, startLocal: "09:00", validFrom: null }),
  ]);
  assert.deepEqual(
    sorted.map((entry) => `${entry.weekdayIso}/${entry.startLocal}/${entry.validFrom ?? "-"}`),
    ["1/09:00/-", "1/09:00/2026-07-01", "1/14:00/-", "3/09:00/-"],
  );
});

// --- ESZ-064: exceptions ---------------------------------------------------

test("exception window prevalidation refuses empty, inverted and overlapping plages", () => {
  assert.deepEqual(exceptionWindowIssues([]), []);
  assert.deepEqual(
    exceptionWindowIssues([{ startLocal: "17:00", endLocal: "14:00", foldUtcOffset: null }]).map(
      (i) => i.field,
    ),
    ["window"],
  );
  assert.deepEqual(
    exceptionWindowIssues([{ startLocal: "14:00", endLocal: "14:00", foldUtcOffset: null }]).map(
      (i) => i.field,
    ),
    ["window"],
  );

  const overlapping = exceptionWindowIssues([
    { startLocal: "09:00", endLocal: "12:00", foldUtcOffset: null },
    { startLocal: "11:00", endLocal: "14:00", foldUtcOffset: null },
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].index, 1);

  assert.deepEqual(
    exceptionWindowIssues([
      { startLocal: "09:00", endLocal: "12:00", foldUtcOffset: null },
      { startLocal: "14:00", endLocal: "17:00", foldUtcOffset: null },
    ]),
    [],
  );
});

test("applying a server exception replaces the date's entry and a removal drops it", () => {
  const closed: AdminAvailabilityException = {
    id: 1,
    localDate: "2026-06-15",
    kind: "closed",
    windows: [],
    note: null,
  };
  const other: AdminAvailabilityException = { ...closed, id: 2, localDate: "2026-07-20" };

  const added = replaceException([other], "2026-06-15", closed);
  assert.deepEqual(added.map((entry) => entry.localDate), ["2026-06-15", "2026-07-20"]);

  const reopened: AdminAvailabilityException = {
    ...closed,
    kind: "open",
    windows: [{ startLocal: "14:00", endLocal: "16:00", foldUtcOffset: null }],
  };
  const updated = replaceException(added, "2026-06-15", reopened);
  assert.equal(updated.length, 2, "an update duplicated the date instead of replacing it");
  assert.equal(exceptionForDate(updated, "2026-06-15")?.kind, "open");

  const removed = replaceException(updated, "2026-06-15", null);
  assert.deepEqual(removed.map((entry) => entry.localDate), ["2026-07-20"]);
  assert.equal(exceptionForDate(removed, "2026-06-15"), null);
});

test("a date exception replaces the weekly windows and removing it restores them", () => {
  // 2026-06-15 is a Monday.
  assert.equal(isoWeekday("2026-06-15"), 1);
  assert.equal(isoWeekday("2026-06-21"), 7, "Sunday must be ISO 7, not 0");

  const rules = [draft({ weekdayIso: 1, startLocal: "09:00", endLocal: "12:00" })];

  const weekly = describeDate("2026-06-15", rules, []);
  assert.equal(weekly.kind, "weekly");
  assert.deepEqual(weekly.windows, ["09:00 – 12:00"]);

  const closed = describeDate("2026-06-15", rules, [
    { id: 1, localDate: "2026-06-15", kind: "closed", windows: [], note: null },
  ]);
  assert.equal(closed.kind, "closed");
  assert.deepEqual(closed.windows, []);

  // The weekly 09:00–12:00 must be absent: an open exception replaces, never merges.
  const opened = describeDate("2026-06-15", rules, [
    {
      id: 1,
      localDate: "2026-06-15",
      kind: "open",
      windows: [{ startLocal: "14:00", endLocal: "16:00", foldUtcOffset: null }],
      note: null,
    },
  ]);
  assert.equal(opened.kind, "exception");
  assert.deepEqual(opened.windows, ["14:00 – 16:00"]);

  // And removing it is the whole of restoring the weekly behaviour.
  assert.deepEqual(describeDate("2026-06-15", rules, []).windows, ["09:00 – 12:00"]);
});

test("an inactive or out-of-validity weekly rule does not open a date", () => {
  assert.equal(
    describeDate("2026-06-15", [draft({ weekdayIso: 1, isActive: false })], []).kind,
    "closed",
  );
  assert.equal(
    describeDate("2026-06-15", [draft({ weekdayIso: 1, validFrom: "2026-07-01" })], []).kind,
    "closed",
  );
  assert.equal(
    describeDate("2026-06-15", [draft({ weekdayIso: 1, validUntil: "2026-06-01" })], []).kind,
    "closed",
  );
  assert.equal(
    describeDate(
      "2026-06-15",
      [draft({ weekdayIso: 1, validFrom: "2026-06-15", validUntil: "2026-06-15" })],
      [],
    ).kind,
    "weekly",
    "an inclusive validity bound excluded its own boundary date",
  );
});

// --- UI guarantees ---------------------------------------------------------

test("the editor adopts server state, confirms destructive changes and stays accessible", async () => {
  const source = await readFile(
    new URL("../app/components/admin/admin-availability-editor.tsx", import.meta.url),
    "utf8",
  );

  // Server state, never the request, is what the editor renders after a save.
  assert.match(source, /adopt\(toDrafts\(result\.value\)\)/);
  assert.match(source, /The response, never the request/);

  // Destructive changes are confirmed rather than one click away.
  assert.match(source, /setConfirmation\(\{ kind: "close"/);
  assert.match(source, /setConfirmation\(\{ kind: "remove"/);
  assert.match(source, /setConfirmation\(\{ kind: "clear-weekly" \}\)/);
  assert.match(source, /Aucun rendez-vous n’est supprimé/);

  // A refused save must say the previous schedule survived.
  assert.match(source, /l’horaire précédent est toujours en place/);

  // Session expiry and a stale token are handled distinctly.
  assert.match(source, /markExpired\(\)/);
  assert.match(source, /refreshSession\(\)/);

  // Error and focus states.
  assert.match(source, /aria-invalid=/);
  assert.match(source, /aria-describedby=/);
  assert.match(source, /role=\{alert \? "alert" : "status"\}/);
  assert.match(source, /noticeRef\.current\?\.focus/);
  assert.match(source, /confirmHeadingRef\.current\?\.focus/);
  assert.match(source, /draftHeadingRef\.current\?\.focus/);
  assert.match(source, /tabIndex=\{-1\}/);

  // Saving is blocked while the set is known-bad, and the whole set is sent.
  assert.match(source, /disabled=\{saving \|\| issues\.length > 0\}/);
  assert.match(source, /replaceWeeklyAvailability\(\{ rules: toRequest\(rules\) \}, csrfToken\)/);

  // Responsive: the editor must not be a fixed two-column desktop layout.
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_400px\]/);
  assert.match(source, /sm:grid-cols-2 lg:grid-cols-4/);

  // The replacement semantics are stated to the operator, not only to the server.
  assert.match(source, /elle ne s’y ajoute pas/);
});

test("the summary is read-only, server-counted and never lists a cancellation", async () => {
  const source = await readFile(
    new URL("../app/components/admin/admin-operations-summary.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /api\.bookingsSummary\(\{ upcomingDays: UPCOMING_DAYS \}\)/);
  assert.match(source, /summary\.counts\.todayConfirmed/);
  assert.match(source, /summary\.counts\.upcomingConfirmed/);

  // Cancellations are shown, and shown as their own number.
  assert.match(source, /hors compte actif/);

  // It renders the server's entries directly; it does not filter a list itself,
  // which is what would let a cancelled booking be counted as an appointment.
  assert.match(source, /summary\.today\.map/);
  assert.match(source, /summary\.upcoming\.slice\(0, 6\)/);
  assert.ok(
    !/state === "cancelled"/.test(source),
    "the summary re-derives state instead of trusting the server partition",
  );

  assert.match(source, /markExpired\(\)/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /sm:grid-cols-3/);
});

test("the admin shell links the availability editor", async () => {
  const source = await readFile(
    new URL("../app/admin/(protected)/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /href="\/admin\/availability"/);
  assert.match(source, /Disponibilités/);
});
