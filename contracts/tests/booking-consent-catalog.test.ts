import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_CONSENT_CURRENT_NOTICE_ID,
  BOOKING_CONSENT_NOTICE_ID_PATTERN,
  bookingConsentCurrentNotice,
  bookingConsentNoticeIds,
  bookingConsentNoticePolicy,
  bookingConsentNoticeTexts,
} from "../booking.js";
import { publicBookingCreateRequestSchema } from "../http-contract.js";

/**
 * ESZ-142 — the consent-notice catalog is the single authority for what the
 * checkbox displays and what a booking request may send.
 *
 * These are the invariant properties a future wording change must preserve:
 * appending an entry is the only permitted edit, the current pointer must
 * name a real entry, and the wire schema must only accept ids the catalog
 * carries — never client-supplied text.
 */
test("the catalog entries are unique and every id matches the bounded-ASCII pattern", () => {
  assert.ok(bookingConsentNoticeIds.length >= 1, "the catalog must not be empty");
  assert.equal(new Set(bookingConsentNoticeIds).size, bookingConsentNoticeIds.length);
  const pattern = new RegExp(BOOKING_CONSENT_NOTICE_ID_PATTERN);
  for (const id of bookingConsentNoticeIds) {
    assert.match(id, pattern, id);
    // ASCII-only, so the stored value can never carry text or a non-ASCII byte.
    assert.ok(Buffer.from(id, "ascii").toString("ascii") === id, `${id} is not ASCII`);
  }
});

test("every issued id has an exact text and the current pointer names an entry", () => {
  for (const id of bookingConsentNoticeIds) {
    assert.equal(
      typeof bookingConsentNoticeTexts[id],
      "string",
      `notice ${id} has no text`,
    );
  }
  assert.ok(
    bookingConsentNoticeIds.includes(BOOKING_CONSENT_CURRENT_NOTICE_ID),
    "the current notice id must name a catalog entry",
  );
  assert.equal(bookingConsentCurrentNotice.id, BOOKING_CONSENT_CURRENT_NOTICE_ID);
  assert.equal(
    bookingConsentCurrentNotice.text,
    bookingConsentNoticeTexts[BOOKING_CONSENT_CURRENT_NOTICE_ID],
  );
});

test("the current notice text is the exact user-visible French sentence", () => {
  assert.equal(
    bookingConsentCurrentNotice.text,
    "J’accepte que mes coordonnées soient utilisées pour traiter cette demande de rendez-vous.",
  );
});

test("the domain artifact block and the exported catalog agree", () => {
  assert.deepEqual(
    bookingConsentNoticePolicy.entries.map((entry) => entry.id),
    [...bookingConsentNoticeIds],
  );
  assert.equal(bookingConsentNoticePolicy.currentId, BOOKING_CONSENT_CURRENT_NOTICE_ID);
  assert.equal(bookingConsentNoticePolicy.idPattern, BOOKING_CONSENT_NOTICE_ID_PATTERN);
});

test("the create schema accepts exactly the current notice id with explicit consent", () => {
  const base = {
    serviceKey: "brows",
    startsAtUtc: "2026-06-15T07:00:00.000Z",
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: null,
    customerNote: null,
  };

  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      consentNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
      consentAccepted: true,
    }).success,
    true,
  );
  // Every issued id — not only the current one — stays structurally acceptable:
  // historical stored ids must never become invalid while their entries remain.
  for (const id of bookingConsentNoticeIds) {
    assert.equal(
      publicBookingCreateRequestSchema.safeParse({
        ...base,
        consentNoticeId: id,
        consentAccepted: true,
      }).success,
      true,
      id,
    );
  }
});

test("the create schema refuses a missing or unknown notice id and refused consent", () => {
  const base = {
    serviceKey: "brows",
    startsAtUtc: "2026-06-15T07:00:00.000Z",
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: null,
    customerNote: null,
  };

  assert.equal(
    publicBookingCreateRequestSchema.safeParse({ ...base, consentAccepted: true }).success,
    false,
    "a request without consentNoticeId must be refused",
  );
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      consentNoticeId: "booking-consent-9999",
      consentAccepted: true,
    }).success,
    false,
    "an unknown notice id must be refused",
  );
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      consentNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
      consentAccepted: false,
    }).success,
    false,
    "consentAccepted must stay explicitly true",
  );
  // The schema is strict: it carries the notice id, never notice text.
  assert.equal(
    publicBookingCreateRequestSchema.safeParse({
      ...base,
      consentNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
      consentAccepted: true,
      consentNoticeText: bookingConsentCurrentNotice.text,
    }).success,
    false,
    "no request field may carry notice text",
  );
});
