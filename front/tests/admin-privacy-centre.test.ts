import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_PRIVACY_REQUESTS_PATH,
  ADMIN_PRIVACY_REQUESTS_QUERY_PATH,
  ADMIN_PRIVACY_REQUEST_ACTIONS_PATH,
  ADMIN_PRIVACY_REQUEST_SEARCH_PATH,
  PRIVACY_REQUEST_MAX_BOOKING_REFERENCES,
  privacyRequestStatuses,
  privacyRequestTypes,
} from "@eszter/contracts";
import { createAdminApiClient, type AdminPrivacyRequestScopeBooking } from "../app/lib/admin-api";
import {
  ADMIN_PRIVACY_MESSAGES,
  PRIVACY_BOOKING_MARKER_LABELS,
  PRIVACY_CONFIRMATIONS,
  PRIVACY_REQUEST_STATUS_LABELS,
  PRIVACY_REQUEST_STEPS,
  PRIVACY_REQUEST_TYPE_LABELS,
  PRIVACY_REQUEST_TYPES,
  availableActions,
  classifyIdentification,
  defaultExportFormat,
  describeScopeCompleteness,
  exportFileContents,
  exportMimeType,
  mergeMatches,
  privacyFailureMessage,
  rectificationEntries,
  scopeIsRecordable,
  toggleReference,
} from "../app/lib/admin-privacy-requests";

const appRoot = join(process.cwd(), "app");
const centreSource = readFileSync(
  join(appRoot, "components", "admin", "admin-privacy-centre.tsx"),
  "utf8",
);
const overviewSource = readFileSync(
  join(appRoot, "components", "admin", "admin-overview.tsx"),
  "utf8",
);

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const centreCopy = withoutComments(centreSource);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const record = {
  id: 7,
  type: "access",
  status: "received",
  receivedDate: "2026-01-31",
  deadlineDate: "2026-02-28",
  closedAtUtc: null,
  bookingReferences: ["XG73-UVK9"],
  createdAt: "2026-06-13T12:00:00.000Z",
  updatedAt: "2026-06-13T12:00:00.000Z",
};
const match = {
  reference: "XG73-UVK9",
  serviceKeys: ["brows"],
  state: "confirmed" as const,
  startsAtUtc: "2026-06-15T07:00:00.000Z",
  endsAtUtc: "2026-06-15T07:30:00.000Z",
  customerName: "Cliente Exemple",
};

// --- Where the block lives ---------------------------------------------------

test("the overview carries a distinct Traitement RGPD section beside Accès rapides, and no nav entry", () => {
  assert.match(overviewSource, /<AdminPrivacyCentre \/>/);
  assert.match(centreSource, /aria-label="Traitement RGPD"/);
  assert.match(centreSource, />\s*Nouvelle demande\s*</);
  assert.match(centreSource, />\s*Historique\s*</);
  // Its own section, not a fourth quick action and not a shell entry.
  assert.doesNotMatch(overviewSource, /adminNavItem\("privacy/);
  const navigation = readFileSync(join(appRoot, "lib", "admin-navigation.ts"), "utf8");
  assert.doesNotMatch(navigation, /rgpd|privacy/i, "no first-level navigation entry");
});

test("both entry points are modal dialogs that can be left and that return focus", () => {
  assert.match(centreSource, /role="dialog"/);
  assert.match(centreSource, /aria-modal="true"/);
  assert.match(centreSource, /aria-labelledby=\{headingId\}/);
  assert.match(centreSource, /event\.key === "Escape"\) onClose\(\)/);
  assert.match(centreSource, /openerRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(centreSource, /<Link\b|href=/, "a modal never navigates away");
});

// --- The common flow ---------------------------------------------------------

test("the flow is type → identification → search → scope review → record", () => {
  assert.deepEqual([...PRIVACY_REQUEST_STEPS], ["type", "identification", "search", "scope", "recorded"]);
  for (const step of ["type", "identification", "search", "scope", "recorded"]) {
    assert.match(centreSource, new RegExp(`step === "${step}"`), `the modal renders the ${step} step`);
  }
  // Recording is the flow's last step: the scope form submits `record()`.
  // Executing the right (ESZ-164) is a separate, explicit action from the
  // recorded request's detail — never a side effect of recording.
  assert.match(centreSource, /api\.recordPrivacyRequest\(/);
  assert.doesNotMatch(centreSource, /recordPrivacyRequest\([\s\S]{0,600}executePrivacyRequestAction/);
  // The only API calls the centre makes are the register's own reads and
  // writes and the rights execution route: no direct booking mutation, no
  // notification change.
  const apiCalls = [...centreSource.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(apiCalls)].sort(),
    [
      "executePrivacyRequestAction",
      "listPrivacyRequests",
      "readPrivacyRequest",
      "readPrivacyRequestScope",
      "recordPrivacyRequest",
      "searchPrivacyRequestScope",
    ],
    "the centre records and executes through the register's routes only",
  );
});

test("the five frozen types are offered, opposition is not, and each has a French label", () => {
  assert.deepEqual([...PRIVACY_REQUEST_TYPES], [...privacyRequestTypes]);
  assert.deepEqual(Object.keys(PRIVACY_REQUEST_TYPE_LABELS).sort(), [...privacyRequestTypes].sort());
  assert.equal("opposition" in PRIVACY_REQUEST_TYPE_LABELS, false);
  assert.doesNotMatch(centreCopy, /opposition/i);
  assert.match(centreSource, /PRIVACY_REQUEST_TYPES\.map\(/);
});

test("the reception date defaults to today and stays editable before creation", () => {
  assert.match(centreSource, /useState\(\(\) => parisLocalDate\(\)\)/);
  assert.match(centreSource, /type="date"[\s\S]{0,120}value=\{receivedDate\}/);
  assert.match(centreSource, /onChange=\{\(event\) => setReceivedDate\(event\.target\.value\)\}/);
  assert.match(centreSource, /receivedDate, bookingReferences: selected/);
});

test("identification accepts a current or legacy reference or an e-mail, and nothing else", () => {
  assert.deepEqual(classifyIdentification("xg73-uvk9"), { kind: "reference", reference: "XG73-UVK9" });
  assert.deepEqual(classifyIdentification("  XG73-UVK9 "), { kind: "reference", reference: "XG73-UVK9" });
  assert.deepEqual(classifyIdentification("bk_00000000000000000000000000000000"), {
    kind: "reference",
    reference: "bk_00000000000000000000000000000000",
  });
  assert.deepEqual(classifyIdentification("Cliente@Example.test"), {
    kind: "email",
    email: "Cliente@Example.test",
  });
  for (const invalid of ["", "   ", "XG73", "bk_zz", "not an address", "a@b", "@example.test"]) {
    assert.deepEqual(classifyIdentification(invalid), { kind: "invalid" }, JSON.stringify(invalid));
  }
  // An invalid input is refused before any request is sent.
  assert.match(centreSource, /classified\.kind === "invalid"[\s\S]{0,120}identificationInvalid/);
});

// --- Search completeness and scope review -----------------------------------

test("an e-mail search is never silently truncated: partial pages are announced and block the review", () => {
  assert.equal(describeScopeCompleteness({ hasMore: true }, 20), ADMIN_PRIVACY_MESSAGES.scopePartial);
  assert.equal(describeScopeCompleteness({ hasMore: false }, 3), ADMIN_PRIVACY_MESSAGES.scopeComplete);
  assert.equal(describeScopeCompleteness({ hasMore: false }, 0), ADMIN_PRIVACY_MESSAGES.emailNoMatch);

  assert.equal(scopeIsRecordable({ selected: ["XG73-UVK9"], confirmedEmpty: false, hasMore: true }), false);
  // The modal follows the server's cursor and appends without duplicating.
  assert.match(centreSource, /cursor: search\.nextCursor/);
  assert.match(centreSource, /mergeMatches\(search\.matches, result\.value\.matches\)/);
  assert.match(centreSource, /disabled=\{search\.hasMore\}/, "the review waits for the whole list");
  assert.deepEqual(mergeMatches([match], [match, { ...match, reference: "AB23-CD45" }]).map((m) => m.reference), [
    "XG73-UVK9",
    "AB23-CD45",
  ]);
});

test("a shared e-mail never implies all bookings: the scope is an explicit selection or a confirmed empty scope", () => {
  assert.equal(scopeIsRecordable({ selected: [], confirmedEmpty: false, hasMore: false }), false);
  assert.equal(scopeIsRecordable({ selected: [], confirmedEmpty: true, hasMore: false }), true);
  assert.equal(scopeIsRecordable({ selected: ["XG73-UVK9"], confirmedEmpty: false, hasMore: false }), true);
  assert.equal(
    scopeIsRecordable({
      selected: Array.from({ length: PRIVACY_REQUEST_MAX_BOOKING_REFERENCES + 1 }, (_, i) => `R${i}`),
      confirmedEmpty: false,
      hasMore: false,
    }),
    false,
  );

  // Selection is a toggle that keeps order, and it is never pre-filled from
  // the matches.
  assert.deepEqual(toggleReference([], "B"), ["B"]);
  assert.deepEqual(toggleReference(["B"], "A"), ["B", "A"]);
  assert.deepEqual(toggleReference(["B", "A"], "B"), ["A"]);
  assert.match(centreSource, /setSelected\(\[\]\)/);
  assert.doesNotMatch(centreSource, /setSelected\([^)]*matches\.map/, "no select-all from the search");
  assert.match(centreSource, /Je confirme qu’aucune réservation n’est concernée/);
  assert.match(centreSource, /type="checkbox"[\s\S]{0,80}selected\?\.includes\(match\.reference\)/);
});

// --- Data minimisation on the wire -----------------------------------------

test("the record request carries only the type, the reception date and the selected references", async () => {
  const sent: Array<{ path: string; init: RequestInit | undefined }> = [];
  const api = createAdminApiClient(async (input, init) => {
    sent.push({ path: String(input), init });
    return jsonResponse({ request: record });
  });

  const result = await api.recordPrivacyRequest(
    { type: "access", receivedDate: "2026-01-31", bookingReferences: ["XG73-UVK9"] },
    "csrf-token",
  );
  assert.ok(result.ok);
  assert.equal(result.value.deadlineDate, "2026-02-28");
  assert.equal(sent[0]?.path, ADMIN_PRIVACY_REQUESTS_PATH);
  assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
    type: "access",
    receivedDate: "2026-01-31",
    bookingReferences: ["XG73-UVK9"],
  });
  const headers = new Headers(sent[0]?.init?.headers);
  assert.ok(headers.get("x-csrf-token"), "recording is a state change and carries CSRF");

  // The typed address or reference never travels with the record.
  assert.doesNotMatch(centreSource, /recordPrivacyRequest\([\s\S]{0,200}(email|identification)/);
});

test("the search and register reads carry no CSRF and are parsed against the frozen schemas", async () => {
  const sent: Array<{ path: string; init: RequestInit | undefined }> = [];
  const api = createAdminApiClient(async (input, init) => {
    sent.push({ path: String(input), init });
    if (String(input) === ADMIN_PRIVACY_REQUEST_SEARCH_PATH) {
      return jsonResponse({
        matches: [match],
        page: { pageSize: 20, hasMore: true, nextCursor: { startsAtUtc: match.startsAtUtc, reference: match.reference } },
      });
    }
    return jsonResponse({ requests: [record], page: { pageSize: 50, hasMore: false, nextCursor: null } });
  });

  const search = await api.searchPrivacyRequestScope({ mode: "email", email: "cliente@example.test" });
  assert.ok(search.ok);
  assert.equal(search.value.page.hasMore, true);
  const history = await api.listPrivacyRequests({ mode: "history" });
  assert.ok(history.ok);
  assert.equal(history.value.requests[0]?.status, "received");
  assert.equal(sent[1]?.path, ADMIN_PRIVACY_REQUESTS_QUERY_PATH);
  for (const call of sent) {
    assert.equal(new Headers(call.init?.headers).has("x-csrf-token"), false);
  }

  // A 2xx whose body is not the frozen shape is never rendered.
  const malformed = createAdminApiClient(async () => jsonResponse({ request: { ...record, email: "x@y.z" } }));
  const detail = await malformed.readPrivacyRequest(7);
  assert.equal(detail.ok, false);
  assert.ok(!detail.ok && detail.failure.kind === "malformed-response");
});

// --- The register's history and detail --------------------------------------

test("history shows reception date, type, status, closure, references and Voir; detail shows the deadline", () => {
  for (const column of ["Réception", "Type", "Statut", "Clôture", "Références"]) {
    assert.match(centreSource, new RegExp(`<th scope="col"[^>]*>${column}</th>`), column);
  }
  assert.match(centreSource, />\s*Voir\s*</);
  assert.match(centreSource, /api\.readPrivacyRequest\(id\)/);
  assert.match(centreSource, /Réponse attendue avant le[\s\S]{0,120}request\.deadlineDate/);
  // All three automatic statuses are representable and labelled; none is chosen here.
  assert.deepEqual(Object.keys(PRIVACY_REQUEST_STATUS_LABELS).sort(), [...privacyRequestStatuses].sort());
  assert.equal(PRIVACY_REQUEST_STATUS_LABELS.received, "Reçue");
  assert.equal(PRIVACY_REQUEST_STATUS_LABELS.in_progress, "En cours");
  assert.equal(PRIVACY_REQUEST_STATUS_LABELS.closed, "Clôturée");
  assert.doesNotMatch(centreSource, /<select|setStatus\(|status: type|status: "closed"/, "no free status selector");
  assert.match(centreSource, /api\.listPrivacyRequests\(\{ mode: "history", cursor: state\.nextCursor \}\)/);
});

test("the register never renders a requester e-mail or message, and failures are worded per surface", () => {
  // The detail view reads only the record's own fields.
  const detail = centreSource.slice(
    centreSource.indexOf("function RequestDetail("),
    centreSource.indexOf("// --- Exécution des droits"),
  );
  assert.doesNotMatch(detail, /email|message|customer/i);
  assert.equal(
    privacyFailureMessage({ kind: "not-found", message: "media" }, "reference"),
    ADMIN_PRIVACY_MESSAGES.referenceNotFound,
  );
  assert.equal(
    privacyFailureMessage({ kind: "not-found", message: "media" }, "register"),
    ADMIN_PRIVACY_MESSAGES.registerNotFound,
  );
  assert.equal(privacyFailureMessage({ kind: "network", message: "hors ligne" }, "record"), "hors ligne");
  assert.match(centreSource, /failure\.kind === "unauthenticated"[\s\S]{0,80}markExpired\(\)/);
  assert.match(centreSource, /failure\.kind === "forbidden"\) await refreshSession\(\)/);
});

// --- ESZ-164: executing the rights from the detail --------------------------

const scopeBooking: AdminPrivacyRequestScopeBooking = {
  reference: "XG73-UVK9",
  serviceKeys: ["brows"],
  state: "confirmed" as const,
  startsAtUtc: "2026-06-15T07:00:00.000Z",
  endsAtUtc: "2026-06-15T07:30:00.000Z",
  updatedAt: "2026-06-13T12:00:00.000Z",
  customerDataErasedAt: null,
  processingRestrictedAt: null,
  customer: { name: "Cliente Exemple", email: "cliente@example.test", phone: null, note: null },
};
const anonymised: AdminPrivacyRequestScopeBooking = {
  ...scopeBooking,
  reference: "AB23-CD45",
  customerDataErasedAt: "2026-06-13T12:01:00.000Z",
  customer: null,
};
const restricted: AdminPrivacyRequestScopeBooking = {
  ...scopeBooking,
  processingRestrictedAt: "2026-06-13T12:01:00.000Z",
};

test("the detail offers exactly the actions the server would accept, per type, status and booking state", () => {
  // Export: access and portability, open or closed, and never anything else.
  assert.deepEqual(availableActions({ type: "access", status: "received" }, [scopeBooking]), ["export"]);
  assert.deepEqual(availableActions({ type: "portability", status: "closed" }, [anonymised]), ["export"]);
  assert.equal(defaultExportFormat("access"), "html");
  assert.equal(defaultExportFormat("portability"), "json");
  // The three writes: open request and at least one live booking.
  assert.deepEqual(availableActions({ type: "rectification", status: "received" }, [scopeBooking, anonymised]), ["rectify"]);
  assert.deepEqual(availableActions({ type: "rectification", status: "received" }, [anonymised]), []);
  assert.deepEqual(availableActions({ type: "rectification", status: "closed" }, [scopeBooking]), []);
  assert.deepEqual(availableActions({ type: "erasure", status: "in_progress" }, [scopeBooking]), ["anonymize"]);
  assert.deepEqual(availableActions({ type: "erasure", status: "closed" }, [anonymised]), []);
  // Restriction: restrict while open; lift while something is restricted,
  // even after closure — and an anonymised booking is never lifted.
  assert.deepEqual(availableActions({ type: "restriction", status: "received" }, [scopeBooking]), ["restrict"]);
  assert.deepEqual(availableActions({ type: "restriction", status: "closed" }, [restricted]), ["lift"]);
  assert.deepEqual(availableActions({ type: "restriction", status: "closed" }, [scopeBooking]), []);
  assert.deepEqual(
    availableActions({ type: "restriction", status: "closed" }, [{ ...anonymised, processingRestrictedAt: "2026-06-13T12:01:00.000Z" }]),
    [],
  );

  // A rectification is pre-filled from the held data with each booking's
  // own token, and skips the anonymised one entirely.
  assert.deepEqual(rectificationEntries([scopeBooking, anonymised]), [
    {
      reference: "XG73-UVK9",
      expectedUpdatedAt: "2026-06-13T12:00:00.000Z",
      customerName: "Cliente Exemple",
      customerEmail: "cliente@example.test",
      customerPhone: null,
      customerNote: null,
    },
  ]);
});

test("the two markers are the frozen labels, shown in the detail and on the calendar", () => {
  assert.equal(PRIVACY_BOOKING_MARKER_LABELS.anonymised, "Cliente anonymisée — rendez-vous maintenu");
  assert.equal(PRIVACY_BOOKING_MARKER_LABELS.restricted, "Traitement limité");
  assert.match(centreCopy, /PRIVACY_BOOKING_MARKER_LABELS\.anonymised/);
  assert.match(centreCopy, /PRIVACY_BOOKING_MARKER_LABELS\.restricted/);
  const calendar = withoutComments(
    readFileSync(join(appRoot, "components", "admin", "admin-booking-calendar.tsx"), "utf8"),
  );
  assert.match(calendar, /PRIVACY_BOOKING_MARKER_LABELS\.anonymised/);
  assert.match(calendar, /PRIVACY_BOOKING_MARKER_LABELS\.restricted/);
  // An anonymised booking is never named by the stored placeholder, and
  // offers no contact edit.
  assert.match(calendar, /customerDataErasedAt === null \? booking\.customerName/);
  assert.match(calendar, /selected\.customerDataErasedAt === null && <button[^>]*onClick=\{beginContactEdit\}/);
});

test("anonymisation and lift are behind an explicit ticked confirmation, and every action is sent by id with CSRF", async () => {
  // The buttons stay disabled until the confirmation is ticked.
  assert.match(centreCopy, /disabled=\{pending \|\| !confirmAnonymize\}/);
  assert.match(centreCopy, /disabled=\{pending \|\| !confirmLift\}/);
  assert.match(centreCopy, /PRIVACY_CONFIRMATIONS\.anonymize/);
  assert.match(centreCopy, /PRIVACY_CONFIRMATIONS\.lift/);
  assert.match(PRIVACY_CONFIRMATIONS.anonymize, /irréversible|définitive/);
  // The lift lives in the request detail, not on the calendar.
  assert.match(centreCopy, /action: "lift", id: request\.id, confirm: true/);
  assert.doesNotMatch(
    readFileSync(join(appRoot, "components", "admin", "admin-booking-calendar.tsx"), "utf8"),
    /action: "lift"/,
  );
  // The detail is the only place an action starts from, on both entry points.
  assert.equal((centreCopy.match(/<RequestActions/g) ?? []).length, 2);

  const sent: Array<{ path: string; init: RequestInit | undefined }> = [];
  const closed = { ...record, type: "restriction", status: "closed", closedAtUtc: "2026-06-13T12:01:00.000Z" };
  const api = createAdminApiClient(async (input, init) => {
    sent.push({ path: String(input), init });
    if (String(input) === ADMIN_PRIVACY_REQUESTS_QUERY_PATH) {
      return jsonResponse({ request: record, bookings: [scopeBooking, anonymised] });
    }
    return jsonResponse({ request: closed, bookings: [restricted], export: null });
  });

  const scope = await api.readPrivacyRequestScope(7);
  assert.ok(scope.ok);
  assert.equal(scope.value.bookings[1]?.customer, null);
  assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), { mode: "scope", id: 7 });
  assert.equal(new Headers(sent[0]?.init?.headers).has("x-csrf-token"), false, "the scope is a read");

  const result = await api.executePrivacyRequestAction({ action: "restrict", id: 7 }, "csrf-token");
  assert.ok(result.ok);
  assert.equal(result.value.bookings[0]?.processingRestrictedAt, "2026-06-13T12:01:00.000Z");
  assert.equal(sent[1]?.path, ADMIN_PRIVACY_REQUEST_ACTIONS_PATH);
  assert.deepEqual(JSON.parse(String(sent[1]?.init?.body)), { action: "restrict", id: 7 });
  assert.ok(new Headers(sent[1]?.init?.headers).get("x-csrf-token"), "an action is a state change");

  // A stale rectification is the calendar's own 409, worded for this surface.
  assert.equal(
    privacyFailureMessage(
      { kind: "conflict", message: "x", currentRevision: null, errorCode: "REVISION_CONFLICT" },
      "action",
    ),
    ADMIN_PRIVACY_MESSAGES.staleRectification,
  );
});

test("an export is downloaded from the response and stored nowhere; both representations share one document", async () => {
  const document = { format: "eszter.privacy-export", version: 1 };
  const api = createAdminApiClient(async () =>
    jsonResponse({
      request: { ...record, status: "closed", closedAtUtc: "2026-06-13T12:01:00.000Z" },
      bookings: [scopeBooking],
      export: { format: "json", fileName: "export-rgpd-demande-7.json", document },
    }),
  );
  const result = await api.executePrivacyRequestAction({ action: "export", id: 7, format: "json" }, "csrf-token");
  // The frozen document schema is enforced on the client too: a bare
  // `{format, version}` is not a document.
  assert.equal(result.ok, false);

  assert.equal(exportMimeType("html"), "text/html;charset=utf-8");
  assert.equal(exportMimeType("json"), "application/json;charset=utf-8");
  assert.equal(exportFileContents({ format: "html", document: "<!doctype html>" }), "<!doctype html>");
  assert.equal(exportFileContents({ format: "json", document: { a: 1 } }), JSON.stringify({ a: 1 }, null, 2));
  // The file goes to the browser's download and the object URL is revoked;
  // nothing is kept in state or sent anywhere else.
  assert.match(centreCopy, /URL\.createObjectURL\(blob\)/);
  assert.match(centreCopy, /URL\.revokeObjectURL\(url\)/);
  assert.match(centreCopy, /anchor\.download = exported\.fileName/);
  assert.match(ADMIN_PRIVACY_MESSAGES.exported, /conservé nulle part/);
});
