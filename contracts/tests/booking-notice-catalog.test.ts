import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_CONSENT_CURRENT_NOTICE_ID,
  BOOKING_CONSENT_NOTICE_ID_PATTERN,
  BOOKING_PRIVACY_CURRENT_NOTICE_ID,
  BOOKING_PRIVACY_NOTICE_ID_PATTERN,
  BOOKING_PRIVACY_POLICY_PATH,
  BOOKING_REFERENCE_ALPHABET,
  BOOKING_REFERENCE_CURRENT_PATTERN,
  BOOKING_REFERENCE_LEGACY_PATTERN,
  BOOKING_REFERENCE_PATTERN,
  bookingConsentCurrentNotice,
  bookingConsentNoticeIds,
  bookingConsentNoticePolicy,
  bookingConsentNoticeTexts,
  bookingPrivacyCurrentNotice,
  bookingPrivacyNoticeContents,
  bookingPrivacyNoticeIds,
  bookingPrivacyNoticePolicy,
  bookingPrivacyNoticeTexts,
  bookingPublicReferencePolicy,
} from "../booking.js";
import {
  adminBookingSchema,
  adminBookingsQueryRequestSchema,
  publicBookingCreateRequestSchema,
} from "../http-contract.js";

/**
 * ESZ-142 / ESZ-161 — the two notice catalogs are the single authority for
 * what the form displays and what a booking request may send.
 *
 * The consent catalog is frozen history: its entries keep their exact text so
 * the bookings made under them keep meaning what they meant, and no request
 * may name one any more. The privacy-information catalog follows the same
 * append-only discipline for the bookings made since.
 */
const base = {
  serviceKey: "brows",
  startsAtUtc: "2026-06-15T07:00:00.000Z",
  customerName: "Cliente Exemple",
  customerEmail: "cliente@example.test",
  customerPhone: null,
  customerNote: null,
};

test("the historical consent catalog is preserved byte for byte", () => {
  assert.deepEqual([...bookingConsentNoticeIds], ["booking-consent-v1"]);
  assert.equal(
    bookingConsentNoticeTexts["booking-consent-v1"],
    "J’accepte que mes coordonnées soient utilisées pour traiter cette demande de rendez-vous.",
  );
  assert.equal(bookingConsentCurrentNotice.id, BOOKING_CONSENT_CURRENT_NOTICE_ID);
  assert.equal(bookingConsentCurrentNotice.text, bookingConsentNoticeTexts["booking-consent-v1"]);
  assert.deepEqual(
    bookingConsentNoticePolicy.entries.map((entry) => entry.id),
    [...bookingConsentNoticeIds],
  );
  assert.equal(bookingConsentNoticePolicy.idPattern, BOOKING_CONSENT_NOTICE_ID_PATTERN);
  assert.equal(bookingConsentNoticePolicy.status, "historical");
  const pattern = new RegExp(BOOKING_CONSENT_NOTICE_ID_PATTERN);
  for (const id of bookingConsentNoticeIds) assert.match(id, pattern, id);
});

test("the privacy catalog entries are unique, bounded ASCII and each has an exact text", () => {
  assert.ok(bookingPrivacyNoticeIds.length >= 1, "the catalog must not be empty");
  assert.equal(new Set(bookingPrivacyNoticeIds).size, bookingPrivacyNoticeIds.length);
  const pattern = new RegExp(BOOKING_PRIVACY_NOTICE_ID_PATTERN);
  for (const id of bookingPrivacyNoticeIds) {
    assert.match(id, pattern, id);
    assert.ok(Buffer.from(id, "ascii").toString("ascii") === id, `${id} is not ASCII`);
    assert.equal(typeof bookingPrivacyNoticeTexts[id], "string", `notice ${id} has no text`);
    assert.ok(bookingPrivacyNoticeTexts[id].length > 0);
  }
  // A privacy notice id never collides with a historical consent notice id:
  // the two stored columns must stay unmistakable.
  for (const id of bookingPrivacyNoticeIds) {
    assert.equal((bookingConsentNoticeIds as readonly string[]).includes(id), false, id);
  }
  assert.ok(bookingPrivacyNoticeIds.includes(BOOKING_PRIVACY_CURRENT_NOTICE_ID));
  assert.equal(bookingPrivacyCurrentNotice.id, BOOKING_PRIVACY_CURRENT_NOTICE_ID);
  assert.equal(bookingPrivacyCurrentNotice.text, bookingPrivacyNoticeTexts[BOOKING_PRIVACY_CURRENT_NOTICE_ID]);
  assert.equal(bookingPrivacyCurrentNotice.content, bookingPrivacyNoticeContents[BOOKING_PRIVACY_CURRENT_NOTICE_ID]);
});

test("the current privacy notice covers every required statement with repository-owned facts only", () => {
  const content = bookingPrivacyCurrentNotice.content;
  assert.equal(content.controller, "Responsable du traitement : Eszter Gyori.");
  assert.match(content.legalBasis, /exécution de la prestation et démarches précontractuelles/);
  assert.match(content.legalBasis, /Aucun consentement n’est requis/);
  assert.match(content.retention, /90 jours/);
  assert.match(content.recipients, /hébergement, envoi des e-mails/);
  // The five V1 rights (Package 10.3): opposition is not among them.
  assert.match(content.rights, /accès, de rectification, d’effacement, de limitation et de portabilité/);
  assert.doesNotMatch(content.rights, /opposition/);
  assert.equal(content.contact, "Pour l’exercer : contact@esztergyori.com.");
  assert.deepEqual(content.privacyPolicy, {
    label: "Politique de confidentialité",
    href: BOOKING_PRIVACY_POLICY_PATH,
  });
  // The frozen text is exactly the statements in display order.
  assert.equal(
    bookingPrivacyCurrentNotice.text,
    [
      content.controller,
      content.legalBasis,
      content.retention,
      content.recipients,
      content.rights,
      content.contact,
      `${content.privacyPolicy.label} : ${content.privacyPolicy.href}`,
    ].join(" "),
  );
  // No consent wording ever appears in the information notice.
  assert.doesNotMatch(bookingPrivacyCurrentNotice.text, /J’accepte/);
});

test("the domain artifact block and the exported privacy catalog agree", () => {
  assert.deepEqual(
    bookingPrivacyNoticePolicy.entries.map((entry) => entry.id),
    [...bookingPrivacyNoticeIds],
  );
  for (const entry of bookingPrivacyNoticePolicy.entries) {
    assert.equal(entry.legalBasis, "contract");
    assert.equal(entry.text, bookingPrivacyNoticeTexts[entry.id]);
  }
  assert.equal(bookingPrivacyNoticePolicy.currentId, BOOKING_PRIVACY_CURRENT_NOTICE_ID);
  assert.equal(bookingPrivacyNoticePolicy.idPattern, BOOKING_PRIVACY_NOTICE_ID_PATTERN);
  assert.equal(bookingPrivacyNoticePolicy.privacyPolicyPath, BOOKING_PRIVACY_POLICY_PATH);
});

test("the create schema accepts exactly a catalog privacy notice id and no consent field", () => {
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
    }).success,
    true,
  );
  for (const id of bookingPrivacyNoticeIds) {
    assert.equal(
      publicBookingCreateRequestSchema.safeParse({ ...base, privacyNoticeId: id }).success,
      true,
      id,
    );
  }
  assert.equal(
    publicBookingCreateRequestSchema.safeParse(base).success,
    false,
    "a request without privacyNoticeId must be refused",
  );
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({ ...base, privacyNoticeId: "booking-privacy-9999" }).success,
    false,
    "an unknown notice id must be refused",
  );
  // A historical consent notice id is not a privacy notice.
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      privacyNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
    }).success,
    false,
    "a consent notice id must not be accepted as a privacy notice id",
  );
  // Booking no longer models consent: the old fields are unknown keys.
  for (const legacy of [{ consentAccepted: true }, { consentNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID }]) {
    assert.equal(
      publicBookingCreateRequestSchema.safeParse({
        ...base,
        privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
        ...legacy,
      }).success,
      false,
      JSON.stringify(legacy),
    );
  }
  // The schema is strict: it carries the notice id, never notice text.
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
      privacyNoticeText: bookingPrivacyCurrentNotice.text,
    }).success,
    false,
    "no request field may carry notice text",
  );
});

// --- ESZ-161: the public reference, current and legacy ---------------------

test("the reference alphabet is unambiguous uppercase and the current pattern is eight of it", () => {
  assert.equal(BOOKING_REFERENCE_ALPHABET.length, 32);
  for (const ambiguous of ["0", "O", "1", "I", "l"]) {
    assert.equal(BOOKING_REFERENCE_ALPHABET.includes(ambiguous), false, ambiguous);
  }
  assert.equal(BOOKING_REFERENCE_ALPHABET, BOOKING_REFERENCE_ALPHABET.toUpperCase());
  const current = new RegExp(BOOKING_REFERENCE_CURRENT_PATTERN);
  // Every alphabet character is admitted by the class, and nothing else is.
  for (const character of BOOKING_REFERENCE_ALPHABET) {
    assert.match(`${character.repeat(4)}-${character.repeat(4)}`, current, character);
  }
  assert.match(bookingPublicReferencePolicy.current.example, current);
  assert.equal(bookingPublicReferencePolicy.current.example, "XG73-UVK9");
  for (const rejected of ["XG70-UVK9", "XG73-UVKI", "xg73-uvk9", "XG73UVK9", "XG73-UVK", "XG73-UVK9-"]) {
    assert.doesNotMatch(rejected, current, rejected);
  }
});

test("every reference field accepts both frozen shapes and nothing else", () => {
  const accepted = new RegExp(BOOKING_REFERENCE_PATTERN);
  const legacy = new RegExp(BOOKING_REFERENCE_LEGACY_PATTERN);
  const legacyReference = "bk_00000000000000000000000000000000";
  assert.match(legacyReference, legacy);
  assert.match(legacyReference, accepted);
  assert.match("XG73-UVK9", accepted);
  assert.equal(bookingPublicReferencePolicy.accepted, BOOKING_REFERENCE_PATTERN);
  assert.equal(bookingPublicReferencePolicy.legacy.pattern, BOOKING_REFERENCE_LEGACY_PATTERN);
  assert.equal(bookingPublicReferencePolicy.current.pattern, BOOKING_REFERENCE_CURRENT_PATTERN);
  for (const reference of [legacyReference, "XG73-UVK9"]) {
    assert.equal(
      adminBookingsQueryRequestSchema.safeParse({ mode: "reference", reference }).success,
      true,
      reference,
    );
  }
  for (const reference of ["bk_0000", "XG70-UVK9", "xg73-uvk9", "BK_00000000000000000000000000000000"]) {
    assert.equal(
      adminBookingsQueryRequestSchema.safeParse({ mode: "reference", reference }).success,
      false,
      reference,
    );
  }
});

test("an admin booking exposes the consent instant and the privacy notice facts as nullable evidence", () => {
  const booking = {
    reference: "XG73-UVK9",
    serviceKey: "brows",
    serviceKeys: ["brows"],
    combinationKey: null,
    state: "confirmed",
    startsAtUtc: "2026-06-15T07:00:00.000Z",
    endsAtUtc: "2026-06-15T07:30:00.000Z",
    timezone: "Europe/Paris",
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: null,
    customerNote: null,
    consentAtUtc: null,
    privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
    privacyNoticePresentedAtUtc: "2026-06-13T12:00:00.000Z",
    cancelledAtUtc: null,
    cancellationReason: null,
    customerDataErasedAt: null,
    processingRestrictedAt: null,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
  };
  assert.equal(adminBookingSchema.safeParse(booking).success, true);
  // A booking made under ESZ-142: consent instant, no privacy notice.
  assert.equal(
    adminBookingSchema.safeParse({
      ...booking,
      reference: "bk_00000000000000000000000000000000",
      consentAtUtc: "2026-06-13T12:00:00.000Z",
      privacyNoticeId: null,
      privacyNoticePresentedAtUtc: null,
    }).success,
    true,
  );
  assert.equal(
    adminBookingSchema.safeParse({ ...booking, privacyNoticeId: "Not An Id" }).success,
    false,
  );
});
