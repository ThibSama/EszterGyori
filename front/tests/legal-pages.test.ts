import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ADMIN_LEGAL_INFORMATION_PATH,
  CSRF_HEADER,
  LEGAL_NOTICE_PATH,
  PRIVACY_POLICY_PATH,
  bookingPrivacyCurrentNotice,
  emptyLegalInformation,
} from "@eszter/contracts";
import { createAdminApiClient } from "../app/lib/admin-api";
import { LEGAL_API_MESSAGES, loadLegalInformation } from "../app/lib/legal-api";
import {
  ADMIN_LEGAL_MESSAGES,
  LEGAL_DRAFT_ERRORS,
  draftFromInformation,
  draftWarnings,
  informationFromDraft,
  legalFailureMessage,
} from "../app/lib/admin-legal-information";

/**
 * ESZ-165 — the two public legal pages, the footer and booking links that
 * reach them, and the admin settings surface that feeds them.
 */

const appRoot = join(process.cwd(), "app");
const read = (...segments: string[]) => readFileSync(join(appRoot, ...segments), "utf8");

test("the two legal pages are distinct exported routes reading one public document", () => {
  assert.equal(LEGAL_NOTICE_PATH, "/mentions-legales");
  assert.equal(PRIVACY_POLICY_PATH, "/confidentialite");
  assert.ok(existsSync(join(appRoot, "mentions-legales", "page.tsx")));
  assert.ok(existsSync(join(appRoot, "confidentialite", "page.tsx")));

  const notice = read("components", "legal", "legal-notice.tsx");
  const privacy = read("components", "legal", "privacy-policy.tsx");
  const frame = read("components", "legal", "legal-page-frame.tsx");

  // Two pages, two main landmarks, one frame that reads `/api/legal`.
  assert.match(notice, /mainId="legal-notice-main"/);
  assert.match(privacy, /mainId="privacy-policy-main"/);
  assert.match(frame, /loadLegalInformation\(fetch, controller\.signal\)/);
  assert.match(frame, /<main id=\{mainId\} tabIndex=\{-1\}/);

  // The notice renders the contract's projection and nothing else: no
  // placeholder, no "N/A", no warning copy reaches the public page.
  assert.match(notice, /publicLegalFacts\(state\.information\)/);
  assert.doesNotMatch(notice, /N\/A|non renseign|manquant/i);
  assert.doesNotMatch(privacy, /N\/A|non renseign|manquant/i);
  assert.doesNotMatch(frame, /legalInformationWarnings/);

  // The privacy policy reuses the frozen notice facts rather than restating
  // them, and never edits the notice.
  assert.match(privacy, /bookingPrivacyCurrentNotice/);
  for (const key of ["legalBasis", "retention", "recipients", "rights"] as const) {
    assert.match(privacy, new RegExp(`notice\\.${key}`));
  }
  assert.equal(bookingPrivacyCurrentNotice.content.privacyPolicy.href, PRIVACY_POLICY_PATH);
});

test("the footer keeps its content links and adds the two fixed legal links; the booking form still points at /confidentialite", () => {
  const preview = read("components", "site-preview.tsx");
  const footer = preview.slice(preview.indexOf("function Footer("), preview.indexOf("function AtmosphericLayer("));
  assert.match(footer, /content\.links\.map/);
  assert.match(footer, /LEGAL_PAGE_LINKS\.map/);
  // Fixed constants, not SiteContent fields: no editable URL reaches the legal pages.
  assert.doesNotMatch(footer, /content\.legal/);

  const details = read("components", "reservation", "reservation-details.tsx");
  assert.match(details, /bookingPrivacyCurrentNotice\.content\.privacyPolicy\.href/);
});

test("the public read parses the frozen document and degrades to one neutral message", async () => {
  const ok = await loadLegalInformation(async (input, init) => {
    assert.equal(String(input), "/api/legal");
    assert.equal(init?.method, "GET");
    return Response.json({ information: emptyLegalInformation() });
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value, emptyLegalInformation());

  const malformed = await loadLegalInformation(async () => Response.json({ information: { legalName: "x" } }));
  assert.ok(!malformed.ok && malformed.failure.kind === "malformed");
  const rejected = await loadLegalInformation(async () => new Response("", { status: 500 }));
  assert.ok(!rejected.ok && rejected.failure.kind === "rejected");
  const network = await loadLegalInformation(async () => {
    throw new TypeError("offline");
  });
  assert.ok(!network.ok && network.failure.kind === "network");
  assert.equal(network.ok ? "" : network.failure.message, LEGAL_API_MESSAGES.unavailable);
});

test("the admin draft round-trips, refuses malformed identifiers and reports missing required facts", () => {
  const empty = draftFromInformation(emptyLegalInformation());
  assert.equal(empty.vatApplicable, true);
  assert.equal(empty.salonAddressApplicable, true);
  assert.deepEqual(informationFromDraft(empty), { ok: true, information: emptyLegalInformation() });
  // Every required fact is missing on a fresh deployment, and that is a
  // warning — not a refusal: the empty document can be saved as it is.
  assert.equal(draftWarnings(empty).length, 11);

  const filled = {
    ...empty,
    legalName: "  Exemple EI ",
    legalForm: "Entrepreneur individuel",
    siren: "123456789",
    siret: "12345678900012",
    vatApplicable: false,
    activity: "Maquillage permanent",
    contactEmail: "contact@example.test",
    hostingName: "Hébergeur Exemple",
    hostingAddress: "1 rue de l’Exemple\n59000 Lille",
    registeredAddress: "1 rue de l’Exemple\n59000 Lille",
    salonAddressApplicable: false,
    registers: [{ label: "", reference: "" }],
  };
  const result = informationFromDraft(filled);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.information.legalName, "Exemple EI");
    assert.deepEqual(result.information.vat, { applicable: false });
    assert.deepEqual(result.information.salonAddress, { applicable: false });
    assert.deepEqual(result.information.registers, [], "an empty register row is no register");
    assert.equal(result.information.tradeName, null, "an empty field is unknown, never an empty string");
  }
  assert.deepEqual(draftWarnings(filled), []);

  // Switching applicability back on without a value is a warning, not an error.
  const vatUnknown = { ...filled, vatApplicable: true };
  assert.ok(informationFromDraft(vatUnknown).ok);
  assert.deepEqual(draftWarnings(vatUnknown).map((warning) => warning.field), ["vat.number"]);

  const refused = informationFromDraft({
    ...filled,
    siren: "12",
    vatApplicable: true,
    vatNumber: "12",
    contactEmail: "not-an-address",
    hostingWebsite: "hebergeur.example",
    registers: [{ label: "RCS", reference: "" }],
  });
  assert.ok(!refused.ok);
  if (!refused.ok) {
    assert.equal(refused.errors.siren, LEGAL_DRAFT_ERRORS.siren);
    assert.equal(refused.errors.vatNumber, LEGAL_DRAFT_ERRORS.vatNumber);
    assert.equal(refused.errors.contactEmail, LEGAL_DRAFT_ERRORS.contactEmail);
    assert.equal(refused.errors.hostingWebsite, LEGAL_DRAFT_ERRORS.hostingWebsite);
    assert.equal(refused.errors["registers.0"], LEGAL_DRAFT_ERRORS.register);
  }

  assert.equal(legalFailureMessage({ kind: "conflict", message: "x", currentRevision: null, errorCode: "REVISION_CONFLICT" }), ADMIN_LEGAL_MESSAGES.conflict);
});

test("the admin settings page reads and saves through the frozen route, with CSRF on the save only", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const stored = { information: emptyLegalInformation(), revision: 0, updatedAt: null };
  const client = createAdminApiClient(async (input, init) => {
    calls.push({ path: String(input), init: init ?? {} });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { expectedRevision: number };
      return Response.json({ ...stored, revision: body.expectedRevision + 1, updatedAt: "2026-06-13T12:00:00.000Z" });
    }
    return Response.json(stored);
  });

  const readResult = await client.readLegalInformation();
  assert.ok(readResult.ok && readResult.value.revision === 0);
  assert.equal(calls[0].path, ADMIN_LEGAL_INFORMATION_PATH);
  assert.equal(new Headers(calls[0].init.headers).get(CSRF_HEADER), null);

  const saved = await client.saveLegalInformation(
    { expectedRevision: 0, information: emptyLegalInformation() },
    "csrf-token",
  );
  assert.ok(saved.ok && saved.value.revision === 1);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(new Headers(calls[1].init.headers).get(CSRF_HEADER), "csrf-token");

  // The page itself: one warnings panel, wired to the live draft, and the
  // section the information architecture names.
  const page = read("components", "admin", "admin-settings.tsx");
  assert.match(page, /Informations juridiques/);
  assert.match(page, /draftWarnings\(draft\)/);
  assert.match(page, /data-testid="legal-warnings"/);
  assert.match(page, /api\.saveLegalInformation\(/);
  assert.match(page, /expectedRevision: stored\.revision/);
});
