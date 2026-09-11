import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_NAV_ITEMS,
  activeAdminNavKey,
  adminNavItem,
} from "../app/lib/admin-navigation";
import { createAdminApiClient } from "../app/lib/admin-api";
import { describeDate, toDrafts } from "../app/lib/admin-availability";
import {
  ADMIN_DRAFT_FRESHNESS_LABELS,
  createInitialDraftState,
  describeDraftFreshness,
} from "../app/lib/admin-server-draft";

const appRoot = join(process.cwd(), "app");

const overviewSource = readFileSync(
  join(appRoot, "components", "admin", "admin-overview.tsx"),
  "utf8",
);
const adminPageSource = readFileSync(
  join(appRoot, "admin", "(protected)", "page.tsx"),
  "utf8",
);
const contentPageSource = readFileSync(
  join(appRoot, "admin", "(protected)", "content", "page.tsx"),
  "utf8",
);

/**
 * The source with its comments removed.
 *
 * The vocabulary bans below are about what Esther is shown, not about the prose
 * explaining why she is not shown it — a comment saying "no revenue metric here"
 * must not read as a revenue metric.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const overviewCopy = withoutComments(overviewSource);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- The route transition --------------------------------------------------

test("/admin renders the operational overview, not the content editor", () => {
  assert.match(adminPageSource, /<AdminOverview \/>/);
  assert.doesNotMatch(
    adminPageSource,
    /ContentEditor/,
    "the CMS must no longer be what `/admin` renders",
  );
});

test("the CMS still exists, unchanged, at its own route", () => {
  assert.ok(
    existsSync(join(appRoot, "admin", "(protected)", "content", "page.tsx")),
    "/admin/content must be backed by a real page",
  );
  // The move is an address change and nothing else: the same component, given
  // the same default content it was given at `/admin`.
  assert.match(contentPageSource, /<ContentEditor defaultContent=\{getDefaultSiteContent\(\)\} \/>/);
});

test("the editor itself was not redesigned by the move", () => {
  // ESZ-156 owns the CMS's UX. The route split must not have touched the
  // controls that make the editor safe to use.
  const editor = readFileSync(
    join(appRoot, "components", "admin", "content-editor.tsx"),
    "utf8",
  );
  for (const marker of [
    /handlePublish/,
    /handleSaveDraft/,
    /admin-revision-conflict/,
    /getPublishedState/,
    /getLocalBackupState/,
  ]) {
    assert.match(editor, marker, `the editor lost ${marker} in the route move`);
  }
});

test("“Vue d’ensemble” and “Contenu du site” point at the routes they now own", () => {
  const overview = adminNavItem("overview");
  const content = adminNavItem("content");

  assert.ok(overview.status === "available" && overview.href === "/admin");
  assert.ok(overview.status === "available" && overview.exact, "/admin must match exactly");
  assert.ok(content.status === "available" && content.href === "/admin/content");

  assert.equal(activeAdminNavKey("/admin"), "overview");
  assert.equal(activeAdminNavKey("/admin/content"), "content");
});

test("the accepted Calendrier mapping survives ESZ-155 and Prestations is live since ESZ-149", () => {
  const calendar = adminNavItem("calendar");
  assert.ok(calendar.status === "available" && calendar.href === "/admin/bookings");
  // Availability is still represented by Calendrier rather than by an entry of
  // its own — the ESZ-154 contract this checkpoint builds on.
  assert.equal(activeAdminNavKey("/admin/availability"), "calendar");

  const services = adminNavItem("services");
  assert.ok(services.status === "available" && services.href === "/admin/services");
  assert.equal(activeAdminNavKey("/admin/services"), "services");
});

test("no navigation or quick action points at a route that does not exist", () => {
  const routes: Record<string, string> = {
    "/admin": join(appRoot, "admin", "(protected)", "page.tsx"),
    "/admin/content": join(appRoot, "admin", "(protected)", "content", "page.tsx"),
    "/admin/bookings": join(appRoot, "admin", "(protected)", "bookings", "page.tsx"),
    "/admin/services": join(appRoot, "admin", "(protected)", "services", "page.tsx"),
  };

  for (const item of ADMIN_NAV_ITEMS) {
    if (item.status !== "available") continue;
    const page = routes[item.href];
    assert.ok(page !== undefined, `${item.href} is not a known admin route`);
    assert.ok(existsSync(page), `${item.href} must be backed by a page on disk`);
  }
});

// --- The quick actions -----------------------------------------------------

test("the quick actions read the navigation model rather than repeating routes", () => {
  // This is what stops the overview offering a destination the shell calls
  // pending, or pointing at a route the shell does not know about.
  assert.match(overviewSource, /adminNavItem\("calendar"\)/);
  assert.match(overviewSource, /adminNavItem\("content"\)/);
  assert.match(overviewSource, /adminNavItem\("services"\)/);

  assert.doesNotMatch(
    overviewSource,
    /href="\/admin\/bookings"|href="\/admin\/content"/,
    "a hard-coded route here could drift away from the shell",
  );
});

test("a pending quick action is inert, exactly like its shell entry", () => {
  const action = overviewSource.slice(overviewSource.indexOf("function QuickAction("));
  const pending = action.slice(0, action.indexOf("return (\n    <Link"));

  assert.match(pending, /<span\b/, "a pending action must not render an anchor");
  assert.match(pending, /aria-disabled="true"/);
  assert.doesNotMatch(pending, /href=/);
  assert.doesNotMatch(pending, /tabIndex/);
  assert.doesNotMatch(pending, /onClick/);
});

// --- The appointments band -------------------------------------------------

test("the overview reuses the operations summary instead of recomputing bookings", () => {
  assert.match(overviewSource, /<AdminOperationsSummary \/>/);
  assert.doesNotMatch(
    overviewSource,
    /bookingsSummary|queryBookings/,
    "there must be exactly one place that decides what today and upcoming mean",
  );
});

// --- Today's hours ---------------------------------------------------------

test("today's hours are the availability editor's own rule, not a new one", () => {
  assert.match(overviewSource, /describeDate\(/);
  assert.match(overviewSource, /toDrafts\(/);
  assert.doesNotMatch(
    overviewCopy,
    /nextAvailable|prochainCreneau|slot/i,
    "no slot-finding algorithm may be invented here — that is Package 10.2",
  );
});

test("a closed day and an open day are both reported from existing truth", () => {
  const monday = "2026-06-15";
  const openRule = {
    id: 1,
    weekdayIso: 1,
    startLocal: "09:00",
    endLocal: "12:00",
    foldUtcOffset: null,
    validFrom: null,
    validUntil: null,
    isActive: true,
  };

  assert.deepEqual(describeDate(monday, toDrafts([openRule]), []), {
    kind: "weekly",
    windows: ["09:00 – 12:00"],
  });

  // A Tuesday has no rule, so it is closed — the same answer the editor gives.
  assert.equal(describeDate("2026-06-16", toDrafts([openRule]), []).kind, "closed");

  // An exception replaces the day rather than adding to it.
  assert.equal(
    describeDate(monday, toDrafts([openRule]), [
      { id: 3, localDate: monday, kind: "closed", windows: [], note: null },
    ]).kind,
    "closed",
  );
});

// --- Site state ------------------------------------------------------------

test("the site state is the editor's freshness rule applied to the server's heads", () => {
  assert.match(overviewSource, /describeDraftFreshness\(/);
  assert.match(overviewSource, /ADMIN_DRAFT_FRESHNESS_LABELS\[/);

  const base = createInitialDraftState();
  assert.equal(
    describeDraftFreshness({ ...base, revision: 4, publishedRevision: 4 }, false),
    "published",
  );
  assert.equal(
    describeDraftFreshness({ ...base, revision: 5, publishedRevision: 4 }, false),
    "saved-unpublished",
  );
  assert.equal(ADMIN_DRAFT_FRESHNESS_LABELS.published, "Publié");
});

test("the site state never comes from this device's local backup", () => {
  assert.doesNotMatch(
    overviewCopy,
    /localStorage|sessionStorage|readLocalBackup/,
    "a local backup is this browser's copy, never the site's published state",
  );
});

test("both heads are required before the overview states a publication status", () => {
  // Knowing the draft head alone cannot tell "everything is published" from
  // "a change is waiting", so a failure on either read must fail the panel.
  const panel = overviewSource.slice(
    overviewSource.indexOf("function SiteStatePanel("),
    overviewSource.indexOf("function SiteState("),
  );
  assert.match(panel, /if \(!draft\.ok\) return draft;/);
  assert.match(panel, /if \(!published\.ok\) return published;/);
});

// --- Loading, empty and error ----------------------------------------------

test("every panel has a distinct loading, error and data branch", () => {
  for (const panel of ["TodayHoursPanel", "SiteStatePanel"]) {
    const body = overviewSource.slice(
      overviewSource.indexOf(`function ${panel}(`),
    );
    const rendered = body.slice(0, body.indexOf("\n}\n"));
    assert.match(rendered, /state\.status === "loading"/, `${panel} needs a loading state`);
    assert.match(rendered, /<PanelLoading/, `${panel} must render its loading state`);
    assert.match(rendered, /state\.status === "error"/, `${panel} needs an error state`);
    assert.match(rendered, /<PanelError/, `${panel} must render its error state`);
  }
});

test("a failed read yields no data at all, so no zero can be rendered", async () => {
  const api = createAdminApiClient(async () => jsonResponse({ error: "boom" }, 500));

  const availability = await api.readAvailability({
    fromDate: "2026-06-15",
    untilDate: "2026-06-15",
  });
  const draft = await api.readDraft();

  assert.equal(availability.ok, false);
  assert.equal(draft.ok, false);
  // The panel state is a discriminated union: an error carries a message and no
  // `data` field, so there is nothing a failing branch could render as a value.
  assert.match(
    overviewSource,
    /\| \{ status: "error"; message: string \}/,
    "the error state must not carry a data payload",
  );
  assert.match(overviewSource, /\| \{ status: "ready"; data: T \}/);
});

test("a failure is announced, and an expired session is escalated instead", () => {
  assert.match(overviewSource, /role="alert"/, "a failure must be announced");
  assert.match(overviewSource, /role="status"/, "a pending read must be announced");
  assert.match(
    overviewSource,
    /failure\.kind === "unauthenticated"[\s\S]{0,80}markExpired\(\)/,
    "an expired session belongs to the whole shell, not to one card",
  );
});

test("the overview does not leak a raw server error to the operator", () => {
  // Only the contract's French messages reach the panel; nothing reads a status
  // code or a response body to build a message of its own.
  assert.match(overviewSource, /failure\.message/);
  assert.doesNotMatch(overviewSource, /\.status\b\s*[,)]|response\.|JSON\.stringify/);
});

// --- What the overview is not allowed to be --------------------------------

test("no price, revenue or accounting metric is invented", () => {
  assert.doesNotMatch(
    overviewCopy,
    /prix|tarif|revenu|chiffre d’affaires|chiffre d'affaires|encaiss|facturation|comptab/i,
  );
});

test("no motivational or decorative filler is introduced", () => {
  assert.doesNotMatch(
    overviewCopy,
    /citation|bonne journée|inspir|motivation|bravo|félicitations/i,
  );
});

test("the overview stays a read-only surface", () => {
  // It reports; it does not mutate. A write here would duplicate authority that
  // already lives in the editor, the calendar and the availability page.
  assert.doesNotMatch(
    overviewSource,
    /saveDraft|publish\(|resetDraft|mutateBooking|replaceWeeklyAvailability|mutateAvailabilityException|uploadMedia|deleteMedia/,
  );
});

// --- Layout ----------------------------------------------------------------

test("the overview stacks on a narrow screen and never scrolls sideways", () => {
  // Two columns from `lg`, one below it — no tiny side-by-side cards on mobile.
  assert.match(overviewSource, /grid max-w-\[1500px\] gap-5 lg:grid-cols-2/);
  assert.match(overviewSource, /grid gap-3 sm:grid-cols-2 lg:grid-cols-3/);
  assert.doesNotMatch(overviewSource, /overflow-x-auto|min-w-\[\d/);
});

test("the quick actions keep a visible focus ring", () => {
  assert.match(overviewSource, /focus:outline-none focus:ring-2 focus:ring-sage-300/);
});
