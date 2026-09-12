import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ADMIN_LEGAL_INFORMATION_PATH,
  PUBLIC_LEGAL_INFORMATION_PATH,
  adminLegalInformationSaveRequestSchema,
  httpContractCases,
  legalInformationPolicy,
} from "../http-contract.js";
import {
  BOOKING_PRIVACY_POLICY_PATH,
  bookingPrivacyCurrentNotice,
} from "../booking.js";
import {
  LEGAL_INFORMATION_SETTING_KEY,
  LEGAL_NOTICE_PATH,
  LEGAL_PAGE_LINKS,
  PRIVACY_POLICY_PATH,
  emptyLegalInformation,
  legalInformationSchema,
  legalInformationWarnings,
  legalWarningFields,
  publicLegalFacts,
  type LegalInformation,
} from "../legal.js";

/**
 * ESZ-165 — the legal-information contract: one nullable model with explicit
 * applicability, admin-only warnings, a public projection that hides what is
 * unset or non-applicable, and the two frozen page paths.
 */

const GENERATED = join(dirname(fileURLToPath(import.meta.url)), "..", "generated");

async function readGenerated(file: string): Promise<string> {
  return readFile(join(GENERATED, file), "utf8");
}

function filled(): LegalInformation {
  return {
    legalName: "Exemple EI",
    tradeName: "Salon Exemple",
    legalForm: "Entrepreneur individuel",
    siren: "123456789",
    siret: "12345678900012",
    registers: [{ label: "Registre national des entreprises", reference: "123 456 789" }],
    vat: { applicable: true, number: "FR12123456789" },
    activity: "Maquillage permanent",
    contact: { email: "contact@example.test", phone: "01 23 45 67 89" },
    hosting: {
      name: "Hébergeur Exemple",
      address: "1 rue de l’Exemple\n59000 Lille",
      phone: null,
      website: "https://hebergeur.example",
    },
    registeredAddress: "1 rue de l’Exemple\n59000 Lille",
    salonAddress: { applicable: true, address: "2 rue du Salon\n59000 Lille" },
  };
}

test("the empty document is all unknown and every required fact warns", () => {
  const empty = emptyLegalInformation();
  assert.equal(legalInformationSchema.safeParse(empty).success, true);
  assert.deepEqual(
    legalInformationWarnings(empty).map((warning) => warning.field),
    [...legalWarningFields],
  );
  // An unknown document publishes nothing at all: no group, no label.
  assert.deepEqual(publicLegalFacts(empty), []);
});

test("a complete document warns about nothing and publishes every fact", () => {
  const information = filled();
  assert.deepEqual(legalInformationWarnings(information), []);
  const groups = publicLegalFacts(information);
  assert.deepEqual(groups.map((group) => group.key), ["identity", "registration", "contact", "hosting"]);
  const labels = groups.flatMap((group) => group.facts.map((fact) => fact.label));
  assert.ok(labels.includes("TVA intracommunautaire"));
  assert.ok(labels.includes("Adresse du salon"));
  assert.ok(labels.includes("Registre national des entreprises"));
  for (const fact of groups.flatMap((group) => group.facts)) {
    assert.notEqual(fact.value, "", `${fact.label} must never be published empty`);
  }
});

test("a non-applicable fact is complete for the admin and absent from the public projection", () => {
  const information: LegalInformation = {
    ...filled(),
    vat: { applicable: false },
    salonAddress: { applicable: false },
    tradeName: null,
    registers: [],
  };
  assert.deepEqual(legalInformationWarnings(information), []);
  const labels = publicLegalFacts(information).flatMap((group) => group.facts.map((fact) => fact.label));
  assert.ok(!labels.includes("TVA intracommunautaire"));
  assert.ok(!labels.includes("Adresse du salon"));
  assert.ok(!labels.includes("Nom commercial"));
  assert.ok(!labels.includes("Registre national des entreprises"));
  assert.ok(!labels.some((label) => /N\/A|non applicable|non renseign/i.test(label)));
});

test("an applicable-but-unknown fact warns the admin and is still hidden from the public", () => {
  const information: LegalInformation = {
    ...filled(),
    vat: { applicable: true, number: null },
    salonAddress: { applicable: true, address: null },
  };
  assert.deepEqual(
    legalInformationWarnings(information).map((warning) => warning.field),
    ["vat.number", "salonAddress.address"],
  );
  const labels = publicLegalFacts(information).flatMap((group) => group.facts.map((fact) => fact.label));
  assert.ok(!labels.includes("TVA intracommunautaire"));
  assert.ok(!labels.includes("Adresse du salon"));
});

test("applicability is structural: a non-applicable VAT cannot carry a number", () => {
  assert.equal(
    legalInformationSchema.safeParse({ ...filled(), vat: { applicable: false, number: "FR12123456789" } }).success,
    false,
  );
  assert.equal(legalInformationSchema.safeParse({ ...filled(), siren: "12" }).success, false);
  assert.equal(legalInformationSchema.safeParse({ ...filled(), capital: "1 €" }).success, false);
  assert.equal(
    adminLegalInformationSaveRequestSchema.safeParse({ expectedRevision: 0, information: emptyLegalInformation() })
      .success,
    true,
  );
});

test("the two public pages are distinct, and the privacy path is the one the ESZ-161 notice froze", () => {
  assert.equal(LEGAL_NOTICE_PATH, "/mentions-legales");
  assert.equal(PRIVACY_POLICY_PATH, "/confidentialite");
  assert.equal(PRIVACY_POLICY_PATH, BOOKING_PRIVACY_POLICY_PATH);
  assert.equal(bookingPrivacyCurrentNotice.content.privacyPolicy.href, PRIVACY_POLICY_PATH);
  assert.notEqual(LEGAL_NOTICE_PATH, PRIVACY_POLICY_PATH);
  assert.deepEqual(
    LEGAL_PAGE_LINKS.map((link) => [link.label, link.href]),
    [
      ["Mentions légales", "/mentions-legales"],
      ["Politique de confidentialité", "/confidentialite"],
    ],
  );
  assert.deepEqual([...legalInformationPolicy.publicPages], [LEGAL_NOTICE_PATH, PRIVACY_POLICY_PATH]);
  assert.equal(legalInformationPolicy.settingKey, LEGAL_INFORMATION_SETTING_KEY);
});

test("the generated HTTP contract freezes the two legal routes and their cases", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    endpoints: Array<{ path: string; methods: string[]; statuses: number[] }>;
    legal: { paths: { public: string; admin: string }; policy: typeof legalInformationPolicy };
  };
  const byPath = Object.fromEntries(contract.endpoints.map((endpoint) => [endpoint.path, endpoint]));
  assert.deepEqual(byPath[PUBLIC_LEGAL_INFORMATION_PATH]?.methods, ["GET"]);
  assert.deepEqual(byPath[ADMIN_LEGAL_INFORMATION_PATH]?.methods, ["GET", "PUT"]);
  assert.ok(byPath[ADMIN_LEGAL_INFORMATION_PATH]?.statuses.includes(409));
  assert.equal(contract.legal.paths.public, "/api/legal");
  assert.equal(contract.legal.paths.admin, "/api/admin/settings/legal");
  assert.deepEqual(contract.legal.policy, legalInformationPolicy);

  const ids = httpContractCases.map((c) => c.id);
  for (const id of [
    "legal.get.ok",
    "legal.post.methodNotAllowed",
    "admin.settings.legal.get.ok",
    "admin.settings.legal.get.unauthenticated",
    "admin.settings.legal.put.ok",
    "admin.settings.legal.put.partialOk",
    "admin.settings.legal.put.staleRevision",
    "admin.settings.legal.put.malformedSiren",
    "admin.settings.legal.put.vatNumberWhenNotApplicable",
    "admin.settings.legal.put.unknownField",
    "admin.settings.legal.put.csrfOmitted",
    "admin.settings.legal.put.unauthenticated",
    "admin.settings.legal.post.methodNotAllowed",
  ]) {
    assert.ok(ids.includes(id), `${id} must be a frozen case`);
  }
  // The public read needs no session; only the PUT carries CSRF.
  const publicRead = httpContractCases.find((c) => c.id === "legal.get.ok");
  assert.equal(publicRead?.auth, undefined);
  const save = httpContractCases.find((c) => c.id === "admin.settings.legal.put.ok");
  assert.equal(save?.auth?.csrf, "valid");
  const request = JSON.parse(save?.request.rawBody ?? "{}") as unknown;
  assert.equal(adminLegalInformationSaveRequestSchema.safeParse(request).success, true);
});
