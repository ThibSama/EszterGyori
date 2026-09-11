import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
  ADMIN_AVAILABILITY_QUERY_PATH,
} from "@eszter/contracts";
import {
  createAdminApiClient,
  type AdminAvailabilityException,
} from "../app/lib/admin-api";
import {
  AVAILABILITY_EDITOR_HORIZON_DAYS,
  type AvailabilityRange,
  needsAvailabilityRead,
  planAvailabilityRange,
  rangeCoversSpan,
  rangeSpanDays,
} from "../app/lib/admin-availability-range";
import { toDrafts, type WeeklyRuleDraft } from "../app/lib/admin-availability";
import { weekDays, weekPlan } from "../app/lib/admin-calendar-week";
import { addCivilDays } from "../app/lib/admin-booking-calendar";

/**
 * ESZ-159 correction — availability coverage follows the calendar.
 *
 * The unified calendar navigates without a bound while one availability read is
 * bounded by the contract's 400-day cap. The first version resolved that by
 * reading `today … today + 180` once and projecting every visible date from it,
 * so a week outside those 180 days was drawn from an exception list that could
 * not contain its exceptions: a stored closure rendered as ordinary weekly
 * hours. These tests drive the same loop the hook runs — plan, read when the
 * window no longer covers the span, project — and assert the projection is the
 * stored exception rather than the weekly fallback.
 */

const TODAY = "2026-09-11";
/** A Monday well before today: the weekly rule would otherwise open it. */
const PAST_EXCEPTION_DATE = "2026-07-06";
/** A Monday past `today + 180` (2027-03-10), the old read's forward edge. */
const FAR_EXCEPTION_DATE = "2027-04-19";

const PAST_CLOSURE: AdminAvailabilityException = {
  id: 1,
  localDate: PAST_EXCEPTION_DATE,
  kind: "closed",
  windows: [],
  note: "Fermeture exceptionnelle",
};

const FAR_OPENING: AdminAvailabilityException = {
  id: 2,
  localDate: FAR_EXCEPTION_DATE,
  kind: "open",
  windows: [{ startLocal: "14:00", endLocal: "18:00", foldUtcOffset: null }],
  note: "Ouverture exceptionnelle",
};

const STORED_EXCEPTIONS = [PAST_CLOSURE, FAR_OPENING];

/** One Monday rule, so a Monday with no exception is unmistakably the fallback. */
const WEEKLY_RULES = [
  {
    id: 11,
    weekdayIso: 1,
    startLocal: "09:00",
    endLocal: "12:00",
    foldUtcOffset: null,
    validFrom: null,
    validUntil: null,
    isActive: true,
  },
];

interface FakeServer {
  api: ReturnType<typeof createAdminApiClient>;
  reads: AvailabilityRange[];
  revision: number;
}

/**
 * The availability read as the server actually behaves: it answers for the range
 * it was given and for nothing else. That is the whole point — a stub that
 * returned every stored exception regardless of the requested range would pass
 * against the broken code too.
 */
function fakeServer(): FakeServer {
  const state: FakeServer = {
    reads: [],
    revision: 7,
    api: undefined as unknown as ReturnType<typeof createAdminApiClient>,
  };
  state.api = createAdminApiClient(async (path, init) => {
    assert.equal(path, ADMIN_AVAILABILITY_QUERY_PATH);
    const body = JSON.parse(String(init?.body)) as AvailabilityRange;
    state.reads.push(body);
    assert.ok(
      rangeSpanDays(body) >= 1 && rangeSpanDays(body) <= ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
      `the server would refuse a ${rangeSpanDays(body)}-day availability range`,
    );
    return new Response(
      JSON.stringify({
        timezone: "Europe/Paris",
        fromDate: body.fromDate,
        untilDate: body.untilDate,
        revision: state.revision,
        weeklyRules: WEEKLY_RULES,
        bookingTimeRules: { minimumLeadMinutes: 0, preferredFinishLocal: null, maxOverrunMinutes: 0 },
        constraints: [],
        exceptions: STORED_EXCEPTIONS.filter(
          (exception) =>
            exception.localDate >= body.fromDate && exception.localDate <= body.untilDate,
        ),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return state;
}

interface Workspace {
  range: AvailabilityRange | null;
  rules: WeeklyRuleDraft[];
  exceptions: AdminAvailabilityException[];
  revision: number | null;
}

const EMPTY: Workspace = { range: null, rules: [], exceptions: [], revision: null };

/**
 * One navigation, exactly as `useAvailabilityWorkspace` performs it: read only
 * when the loaded window stops covering the span, then project the week.
 */
async function navigate(server: FakeServer, workspace: Workspace, anchor: string) {
  const days = weekDays(anchor);
  const visible: AvailabilityRange = { fromDate: days[0], untilDate: days[days.length - 1] };
  let next = workspace;
  if (needsAvailabilityRead(next.range, visible)) {
    const requested = planAvailabilityRange(visible, TODAY);
    const result = await server.api.readAvailability(requested);
    assert.ok(result.ok);
    next = {
      range: requested,
      rules: toDrafts(result.value.weeklyRules),
      exceptions: result.value.exceptions,
      revision: result.value.revision,
    };
  }
  return {
    workspace: next,
    // What the grid gates its shading on: covered, not merely "not loading".
    ready: rangeCoversSpan(next.range, visible),
    plan: weekPlan(days, next.rules, next.exceptions, [], TODAY),
  };
}

test("a visible past week renders its stored exception rather than the weekly fallback", async () => {
  const server = fakeServer();

  const opening = await navigate(server, EMPTY, TODAY);
  assert.ok(opening.ready);
  // The opening read is the editor horizon: the past exception is outside it,
  // which is precisely why navigating back has to read again.
  assert.equal(
    opening.workspace.exceptions.some((one) => one.localDate === PAST_EXCEPTION_DATE),
    false,
  );

  const past = await navigate(server, opening.workspace, PAST_EXCEPTION_DATE);
  assert.ok(past.ready, "the past week was projected from a window that excluded it");
  const day = past.plan.find((entry) => entry.date === PAST_EXCEPTION_DATE);
  assert.ok(day);
  assert.equal(day.kind, "closed");
  assert.deepEqual(day.windows, []);
  assert.equal(server.reads.length, 2);
});

test("a visible week past the 180-day horizon renders its stored exception", async () => {
  const server = fakeServer();
  const horizon = addCivilDays(TODAY, AVAILABILITY_EDITOR_HORIZON_DAYS);
  assert.ok(FAR_EXCEPTION_DATE > horizon, "the far fixture must sit outside the old read");

  const opening = await navigate(server, EMPTY, TODAY);
  assert.equal(
    opening.workspace.exceptions.some((one) => one.localDate === FAR_EXCEPTION_DATE),
    false,
  );

  const far = await navigate(server, opening.workspace, FAR_EXCEPTION_DATE);
  assert.ok(far.ready);
  const day = far.plan.find((entry) => entry.date === FAR_EXCEPTION_DATE);
  assert.ok(day);
  assert.equal(day.kind, "exception");
  assert.deepEqual(day.windows, [{ startLocal: "14:00", endLocal: "18:00" }]);

  // And the weekly fallback is still what an ordinary Monday in that same week
  // resolves to, so the exception is a read fact and not a blanket override.
  const ordinary = far.plan.find((entry) => entry.date === addCivilDays(FAR_EXCEPTION_DATE, 7));
  assert.equal(ordinary, undefined);
});

test("navigation never projects a span the loaded window does not cover", async () => {
  const server = fakeServer();
  let workspace = EMPTY;

  // Every step of a long walk, in both directions, either re-reads or is
  // already covered — it is never projected from a window that excludes it.
  for (const anchor of [
    TODAY,
    addCivilDays(TODAY, 7),
    addCivilDays(TODAY, 400),
    addCivilDays(TODAY, -400),
    addCivilDays(TODAY, 1_500),
    addCivilDays(TODAY, -1_500),
    TODAY,
  ]) {
    const step = await navigate(server, workspace, anchor);
    assert.ok(step.ready, `the week of ${anchor} was projected without coverage`);
    workspace = step.workspace;
  }

  // Ordinary paging inside the loaded window costs no read at all.
  const before = server.reads.length;
  await navigate(server, workspace, addCivilDays(TODAY, 7));
  assert.equal(server.reads.length, before);
});

test("the planned range keeps the visible span whole and never exceeds the server cap", () => {
  const near = planAvailabilityRange(
    { fromDate: TODAY, untilDate: addCivilDays(TODAY, 6) },
    TODAY,
  );
  // Close to today, the editor's forward horizon still fits and is kept.
  assert.equal(near.fromDate, TODAY);
  assert.equal(near.untilDate, addCivilDays(TODAY, AVAILABILITY_EDITOR_HORIZON_DAYS));

  const past = planAvailabilityRange(
    { fromDate: addCivilDays(TODAY, -70), untilDate: addCivilDays(TODAY, -64) },
    TODAY,
  );
  assert.ok(past.fromDate <= addCivilDays(TODAY, -70));
  assert.ok(past.untilDate >= addCivilDays(TODAY, -64));

  for (const offset of [-5_000, -400, -200, 0, 200, 400, 5_000]) {
    const anchor = addCivilDays(TODAY, offset);
    const days = weekDays(anchor);
    const visible = { fromDate: days[0], untilDate: days[days.length - 1] };
    const planned = planAvailabilityRange(visible, TODAY);
    assert.ok(
      rangeSpanDays(planned) <= ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
      `planned ${rangeSpanDays(planned)} days for offset ${offset}`,
    );
    assert.ok(rangeCoversSpan(planned, visible), `offset ${offset} lost its own visible span`);
  }

  // A cap smaller than the horizon proves the priority explicitly: the dates on
  // screen survive, the horizon is what gets dropped.
  const tight = planAvailabilityRange(
    { fromDate: addCivilDays(TODAY, 300), untilDate: addCivilDays(TODAY, 306) },
    TODAY,
    30,
  );
  assert.ok(rangeSpanDays(tight) <= 30);
  assert.ok(
    rangeCoversSpan(tight, {
      fromDate: addCivilDays(TODAY, 300),
      untilDate: addCivilDays(TODAY, 306),
    }),
  );
});

test("coverage is a read fact, not a rule: dateWindows stays the only derivation", async () => {
  const workspace = await readFile(
    new URL("../app/components/admin/admin-availability-editor.tsx", import.meta.url),
    "utf8",
  );
  const grid = await readFile(
    new URL("../app/components/admin/admin-booking-calendar.tsx", import.meta.url),
    "utf8",
  );
  const range = await readFile(
    new URL("../app/lib/admin-availability-range.ts", import.meta.url),
    "utf8",
  );

  // The hook reads for the span it was given, and republishes the window.
  assert.match(workspace, /useAvailabilityWorkspace\(visible: AvailabilityRange\)/);
  assert.match(workspace, /needsAvailabilityRead\(fetchedSpan, span\)/);
  // Busy is derived from the span that was fetched, never hand-raised.
  assert.doesNotMatch(workspace, /setLoading\(/);
  assert.match(workspace, /planAvailabilityRange\(span, today\)/);
  assert.match(workspace, /setCoverage\(requested\)/);
  assert.doesNotMatch(workspace, /HORIZON_DAYS/);

  // The grid gates on coverage, and its edit entry cannot fire for a date whose
  // exception was never read.
  assert.match(grid, /useAvailabilityWorkspace\(visibleSpan\)/);
  assert.match(grid, /availability\.covers\(weekDates\[0\]\)/);
  assert.match(grid, /disabled=\{!availabilityReady\}/);
  assert.match(workspace, /if \(!rangeCoversDate\(coverage, localDate\)\) \{/);

  // No second opinion about what a date is open for: the range module owns
  // coverage and nothing else, and the projection still comes from dateWindows.
  assert.doesNotMatch(range, /dateWindows\(|from "\.\/admin-availability"|startLocal/);
  assert.doesNotMatch(grid, /dateWindows\(/);

  // Writes are untouched: still the server's revision, still its response.
  assert.match(workspace, /\{ \.\.\.body, expectedRevision: revision \}/);
  assert.match(workspace, /setExceptions\(\(current\) => replaceException\(current, localDate, result\.value\.exception\)\)/);
  assert.match(workspace, /setRevision\(result\.value\.revision\)/);

  // Conflict recovery re-reads the window on screen, not a fixed horizon.
  const recovery = workspace.slice(
    workspace.indexOf("const recoverAvailabilityConflict"),
    workspace.indexOf("const updateRule"),
  );
  assert.match(recovery, /api\.readAvailability\(range\)/);
  assert.match(recovery, /setCoverage\(range\)/);
  assert.doesNotMatch(recovery, /replaceWeeklyAvailability|mutateAvailabilityException/);
});
