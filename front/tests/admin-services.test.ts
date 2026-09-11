import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ADMIN_SERVICES_PATH, CSRF_HEADER } from "@eszter/contracts";
import {
  createAdminApiClient,
  type AdminBookableService,
  type AdminServiceCombination,
} from "../app/lib/admin-api";
import {
  ADMIN_SERVICES_MESSAGES,
  SERVICE_STATUS_LABELS,
  adoptStoredService,
  combinationDurationDraft,
  combinationUnavailableReason,
  draftFromService,
  emptyServiceDraft,
  formatServiceDuration,
  isCatalogStale,
  mutationFromDraft,
  parseDuration,
  serviceFailureMessage,
  serviceImageUsages,
  validateCombinationMutation,
  validateServiceDraft,
} from "../app/lib/admin-services";
import { ADMIN_NAV_ITEMS, activeAdminNavKey, adminNavItem } from "../app/lib/admin-navigation";

/**
 * ESZ-149 — the `Prestations` destination: the catalog editor's rules, its
 * API client, and the vocabulary it is allowed to show.
 */

const appRoot = join(process.cwd(), "app");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const servicesSource = withoutComments(
  readFileSync(join(appRoot, "components", "admin", "admin-services.tsx"), "utf8"),
);
const servicesLibSource = withoutComments(
  readFileSync(join(appRoot, "lib", "admin-services.ts"), "utf8"),
);
const calendarSource = readFileSync(
  join(appRoot, "components", "admin", "admin-booking-calendar.tsx"),
  "utf8",
);
const summarySource = readFileSync(
  join(appRoot, "components", "admin", "admin-operations-summary.tsx"),
  "utf8",
);

const MANAGED = "/media/med_" + "a".repeat(32) + ".webp";

function service(overrides: Partial<AdminBookableService> = {}): AdminBookableService {
  return {
    key: "brows",
    label: "Sourcils",
    description: "Poudré ou poil à poil.",
    durationMinutes: 90,
    imageSrc: null,
    status: "active",
    createdAt: "2026-05-01T09:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

/** ESZ-150 — a stored, bookable combination of the two fixture services. */
function combination(overrides: Partial<AdminServiceCombination> = {}): AdminServiceCombination {
  return {
    key: "brows+lips",
    serviceKeys: ["brows", "lips"],
    proposedDurationMinutes: 90,
    durationMinutes: 70,
    status: "validated",
    bookable: true,
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

// --- The destination ---------------------------------------------------------

test("Prestations is a live first-level destination backed by a page", () => {
  const item = adminNavItem("services");
  assert.ok(item.status === "available" && item.href === "/admin/services");
  assert.ok(existsSync(join(appRoot, "admin", "(protected)", "services", "page.tsx")));
  assert.equal(activeAdminNavKey("/admin/services"), "services");
  assert.equal(ADMIN_NAV_ITEMS.filter((entry) => entry.status === "pending").length, 0);
});

// --- The draft rules ---------------------------------------------------------

test("a draft is valid exactly inside the domain bounds", () => {
  assert.deepEqual(validateServiceDraft({ ...emptyServiceDraft(), label: "Sourcils", durationMinutes: "90" }), {});
  assert.deepEqual(
    Object.keys(validateServiceDraft(emptyServiceDraft())).sort(),
    ["durationMinutes", "label"],
  );
  assert.ok(validateServiceDraft({ ...emptyServiceDraft(), label: "x".repeat(161), durationMinutes: "30" }).label);
  assert.ok(
    validateServiceDraft({ ...emptyServiceDraft(), label: "Ok", description: "d".repeat(2001), durationMinutes: "30" })
      .description,
  );
  for (const bad of ["4", "481", "1.5", "-30", "abc", "", " 30 x"]) {
    assert.equal(parseDuration(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
  assert.equal(parseDuration(" 480 "), 480);
  assert.equal(parseDuration("5"), 5);
});

test("a valid draft becomes create while adding and update with the row's token while editing", () => {
  assert.deepEqual(
    mutationFromDraft({
      ...emptyServiceDraft(),
      label: "  Microblading sourcils ",
      description: " Une ligne à la fois. ",
      durationMinutes: "90",
      imageSrc: MANAGED,
    }),
    {
      action: "create",
      label: "Microblading sourcils",
      description: "Une ligne à la fois.",
      durationMinutes: 90,
      imageSrc: MANAGED,
    },
  );

  const draft = draftFromService(service());
  assert.equal(draft.key, "brows");
  assert.equal(draft.expectedUpdatedAt, "2026-06-01T10:00:00.000Z");
  assert.equal(draft.durationMinutes, "90");
  assert.deepEqual(mutationFromDraft({ ...draft, imageSrc: null, durationMinutes: "120" }), {
    action: "update",
    key: "brows",
    expectedUpdatedAt: "2026-06-01T10:00:00.000Z",
    label: "Sourcils",
    description: "Poudré ou poil à poil.",
    durationMinutes: 120,
    imageSrc: null,
  });

  // Never a mutation from an invalid draft: the caller cannot send one by accident.
  assert.equal(mutationFromDraft({ ...draft, durationMinutes: "0" }), null);
  assert.equal(mutationFromDraft({ ...draft, label: "   " }), null);
});

test("the list adopts what the server stored: in place for a known key, appended for a new one", () => {
  const list = [service(), service({ key: "lips", label: "Lèvres" })];
  const edited = adoptStoredService(list, service({ label: "Sourcils poudrés", updatedAt: "2026-06-02T10:00:00.000Z" }));
  assert.deepEqual(edited.map((entry) => entry.label), ["Sourcils poudrés", "Lèvres"]);
  const added = adoptStoredService(list, service({ key: "microblading-sourcils", label: "Microblading" }));
  assert.deepEqual(added.map((entry) => entry.key), ["brows", "lips", "microblading-sourcils"]);
  assert.equal(list.length, 2, "adoption never mutates the previous list");
});

test("image usages count every catalog row, archived included", () => {
  const list = [
    service({ imageSrc: MANAGED }),
    service({ key: "lips", imageSrc: MANAGED, status: "archived" }),
    service({ key: "freckles", imageSrc: null }),
  ];
  assert.equal(serviceImageUsages(list, MANAGED), 2);
  assert.equal(serviceImageUsages(list, "/media/med_" + "b".repeat(32) + ".jpg"), 0);
});

test("durations and statuses read the way the reservation page says them", () => {
  assert.equal(formatServiceDuration(45), "45 min");
  assert.equal(formatServiceDuration(60), "1 h");
  assert.equal(formatServiceDuration(90), "1 h 30");
  assert.deepEqual(SERVICE_STATUS_LABELS, { active: "Active", archived: "Archivée" });
});

test("a conflict or a vanished row means re-read before retrying; the copy says so", () => {
  const conflict = { kind: "conflict" as const, message: "x", currentRevision: null, errorCode: "REVISION_CONFLICT" as const };
  const missing = { kind: "not-found" as const, message: "x" };
  const validation = { kind: "validation" as const, message: "x" };
  assert.equal(isCatalogStale(conflict), true);
  assert.equal(isCatalogStale(missing), true);
  assert.equal(isCatalogStale(validation), false);
  assert.equal(serviceFailureMessage(conflict), ADMIN_SERVICES_MESSAGES.conflict);
  assert.equal(serviceFailureMessage(missing), ADMIN_SERVICES_MESSAGES.notFound);
  assert.equal(serviceFailureMessage(validation), ADMIN_SERVICES_MESSAGES.validation);
  assert.equal(serviceFailureMessage({ kind: "network", message: "hors ligne" }), "hors ligne");
  assert.match(ADMIN_SERVICES_MESSAGES.archived, /rendez-vous existants sont conservés/);
});

// --- The API client -----------------------------------------------------------

function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ path: string; method: string; headers: Headers; body: string | null }> = [];
  let index = 0;
  const fetchImpl = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const headers = new Headers();
    if (next.body !== undefined) headers.set("content-type", "application/json");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers,
    });
  };
  return { calls, fetchImpl };
}

test("the catalog read is a GET on the frozen path and keeps archived rows", async () => {
  const { calls, fetchImpl } = stubFetch([
    {
      status: 200,
      body: {
        services: [service(), service({ key: "lips", status: "archived" })],
        // ESZ-150: the same read carries the maximum and the combinations.
        maxServicesPerAppointment: 2,
        combinations: [combination()],
        combinationsComplete: true,
      },
    },
  ]);
  const result = await createAdminApiClient(fetchImpl).listServices();
  assert.equal(calls[0].path, ADMIN_SERVICES_PATH);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.get(CSRF_HEADER), null, "a read carries no CSRF token");
  assert.ok(result.ok);
  assert.deepEqual(result.value.services.map((entry) => entry.status), ["active", "archived"]);
  assert.equal(result.value.maxServicesPerAppointment, 2);
  assert.equal(result.value.combinations[0].key, "brows+lips");
});

test("a mutation is a PATCH carrying its action and the CSRF token, adopting the stored row", async () => {
  const stored = service({ key: "microblading-sourcils", label: "Microblading sourcils" });
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: { service: stored } }]);
  const result = await createAdminApiClient(fetchImpl).mutateService(
    { action: "create", label: "Microblading sourcils", description: "", durationMinutes: 90, imageSrc: null },
    "csrf-token",
  );
  assert.equal(calls[0].path, ADMIN_SERVICES_PATH);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].headers.get(CSRF_HEADER), "csrf-token");
  assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), {
    action: "create",
    label: "Microblading sourcils",
    description: "",
    durationMinutes: 90,
    imageSrc: null,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value, { service: stored });
});

test("a combination is validated from the listed row and only with a bounded duration", () => {
  // A candidate has no token: the mutation creates the row with Esther's
  // corrected number, never the proposal by itself.
  const candidate = combination({ status: "proposed", durationMinutes: null, updatedAt: null, bookable: false });
  assert.equal(combinationDurationDraft(candidate), "90");
  assert.deepEqual(validateCombinationMutation(candidate, " 75 "), {
    action: "validateCombination",
    serviceKeys: ["brows", "lips"],
    durationMinutes: 75,
    expectedUpdatedAt: null,
  });
  // A stored row re-validates under its token and starts from its own value.
  const stored = combination();
  assert.equal(combinationDurationDraft(stored), "70");
  const revalidation = validateCombinationMutation(stored, "80");
  assert.ok(revalidation?.action === "validateCombination");
  assert.equal(revalidation.expectedUpdatedAt, stored.updatedAt);
  // Out of bounds or not a whole number is never sent.
  assert.equal(validateCombinationMutation(stored, "481"), null);
  assert.equal(validateCombinationMutation(stored, "7.5"), null);

  // Why a stored row is not bookable, stated from the catalog it lists.
  const services = [service(), service({ key: "lips", status: "archived" })];
  assert.equal(combinationUnavailableReason(candidate, services, 2), null);
  assert.equal(combinationUnavailableReason(stored, services, 2), null);
  assert.match(combinationUnavailableReason(combination({ bookable: false }), services, 2) ?? "", /archivée/);
  assert.match(combinationUnavailableReason(combination({ bookable: false, status: "disabled" }), services, 2) ?? "", /Désactivée/);
  assert.match(combinationUnavailableReason(combination({ bookable: false }), [service(), service({ key: "lips" })], 1) ?? "", /maximum de 1/);
});

test("409, 404, 403 and a malformed 200 are typed failures, never adopted", async () => {
  const client = (status: number, body?: unknown) =>
    createAdminApiClient(stubFetch([{ status, body }]).fetchImpl).mutateService(
      { action: "archive", key: "brows", expectedUpdatedAt: "2026-06-01T10:00:00.000Z" },
      "csrf-token",
    );
  const error = (code: string) => ({ error: { code, message: "refused", requestId: "req_test" } });

  const conflict = await client(409, error("REVISION_CONFLICT"));
  assert.ok(!conflict.ok && conflict.failure.kind === "conflict");
  const missing = await client(404, error("NOT_FOUND"));
  assert.ok(!missing.ok && missing.failure.kind === "not-found");
  const csrf = await client(403, error("CSRF_TOKEN_INVALID"));
  assert.ok(!csrf.ok && csrf.failure.kind === "forbidden");
  const expired = await client(401, error("UNAUTHENTICATED"));
  assert.ok(!expired.ok && expired.failure.kind === "unauthenticated");
  const malformed = await client(200, { service: { key: "brows" } });
  assert.ok(!malformed.ok && malformed.failure.kind === "malformed-response");
});

// --- What the page may show ---------------------------------------------------

test("the lists are Prestation, Durée, Statut, Actions — and the combinations' five columns — and nothing financial", () => {
  const headers = [...servicesSource.matchAll(/role="columnheader">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(headers, [
    "Prestation", "Durée", "Statut", "Actions",
    // ESZ-150: the proposal and the validated duration are two columns, so
    // the advisory number is never mistaken for the one that books.
    "Prestations", "Durée proposée", "Durée validée", "Statut", "Actions",
  ]);
  for (const banned of [/prix/i, /tarif/i, /catégorie/i, /categorie/i, /revenu/i, /chiffre d.affaires/i, /statistique/i, /€/]) {
    assert.doesNotMatch(servicesSource, banned);
    assert.doesNotMatch(servicesLibSource, banned);
  }
});

test("the image goes through the media library, never a raw path field", () => {
  assert.match(servicesSource, /<MediaLibraryPanel\b/);
  assert.match(servicesSource, /<MediaLibraryProvider\b/);
  assert.doesNotMatch(servicesSource, /label="Source de l'image"/);
  assert.doesNotMatch(servicesSource, /placeholder="\/media\//);
  // The form's text inputs are exactly the three catalog facts a person types.
  const fields = [...servicesSource.matchAll(/^\s+label="([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(fields, ["Nom", "Description", "Durée (minutes)"]);
});

test("archiving is the only destructive-looking action, confirmed in place, and nothing deletes", () => {
  assert.match(servicesSource, /Confirmer l’archivage/);
  assert.match(servicesSource, /Restaurer/);
  assert.doesNotMatch(servicesSource, /action: "delete"/);
  assert.doesNotMatch(servicesSource, /Supprimer la prestation/);
});

test("the calendar and the summary name services from the catalog, not a hard-coded map", () => {
  for (const source of [calendarSource, summarySource]) {
    assert.doesNotMatch(source, /SERVICE_LABELS/);
    assert.match(source, /useServiceLabel\(\)/);
  }
});
