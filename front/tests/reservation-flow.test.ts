import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_PRIVACY_CURRENT_NOTICE_ID,
  bookingPrivacyCurrentNotice,
  defaultSiteContent,
} from "@eszter/contracts";
import { BOOKING_API_MESSAGES } from "../app/lib/booking-api";
import {
  isRetryBlocked,
  retryAllowedAtEpochMs,
} from "../app/lib/retry-after";
import type { BookingAvailability, BookingSlot } from "../app/lib/booking-api";
import {
  CUSTOMER_NAME_PART_MAX_LENGTH,
  RESERVATION_HORIZON_DAYS,
  bookableServicesToOffer,
  canAddService,
  combinationIsDisabled,
  selectedServiceLabel,
  addCivilDays,
  composeCustomerName,
  createBookingRequest,
  initialReservationState,
  parisToday,
  rangeFrom,
  reservationFlowReducer,
  resolveCombination,
  selectionDurationMinutes,
  selectionIsBookable,
  validateCustomerDraft,
} from "../app/lib/reservation-flow";
import type { ReservationFlowState } from "../app/lib/reservation-flow";

const slot: BookingSlot = {
  localDate: "2026-08-24",
  localStart: "09:15",
  foldUtcOffset: null,
  startsAtUtc: "2026-08-24T07:15:00.000Z",
  endsAtUtc: "2026-08-24T07:45:00.000Z",
};

function availability(slots: BookingSlot[]): BookingAvailability {
  return {
    serviceKey: "brows",
    serviceKeys: ["brows"],
    combinationKey: null,
    timezone: "Europe/Paris",
    fromDate: "2026-08-21",
    untilDate: "2026-08-27",
    slots,
  };
}

test("Paris today ignores the host timezone and ranges stay inside the 90-day horizon", () => {
  assert.equal(parisToday(new Date("2026-03-28T23:30:00.000Z")), "2026-03-29");
  assert.deepEqual(rangeFrom("2026-03-29"), {
    fromDate: "2026-03-29",
    untilDate: "2026-04-04",
  });
  assert.equal(addCivilDays("2026-03-29", RESERVATION_HORIZON_DAYS - 1), "2026-06-26");
});

test("the catalog is offered as served: catalog order, no CMS matching, no duplicate key (ESZ-149)", () => {
  const catalog = [
    { key: "lips", label: "Lèvres réservation", description: "Contour.", durationMinutes: 45, imageSrc: null },
    { key: "microblading-sourcils", label: "Microblading", description: "", durationMinutes: 90, imageSrc: "/media/med_" + "a".repeat(32) + ".webp" },
    { key: "brows", label: "Sourcils réservation", description: "Poudré.", durationMinutes: 30, imageSrc: null },
    { key: "brows", label: "Doublon", description: "", durationMinutes: 30, imageSrc: null },
  ];
  const visible = bookableServicesToOffer(catalog);

  // A key the fixed CMS list never contained is offered exactly like the
  // historical ones, in the order the server chose.
  assert.deepEqual(visible.map((service) => service.key), ["lips", "microblading-sourcils", "brows"]);
  assert.equal(visible[1].imageSrc, "/media/med_" + "a".repeat(32) + ".webp");
  assert.equal(visible[2].label, "Sourcils réservation");
  assert.equal(visible[2].description, "Poudré.");
  assert.ok(
    !defaultSiteContent.services.items.some((item) => (item.id as string) === "microblading-sourcils"),
    "the fixture key must be one the CMS does not know, or this proves nothing",
  );

  assert.equal(selectedServiceLabel(visible, ["microblading-sourcils"]), "Microblading");
  // ESZ-150: a selection of several services is named in the chosen order;
  // a key the catalog does not list renders as itself, never invented.
  assert.equal(selectedServiceLabel(visible, ["microblading-sourcils", "brows"]), "Microblading + Sourcils réservation");
  assert.equal(selectedServiceLabel(visible, ["archived-key"]), "archived-key");
  assert.equal(selectedServiceLabel(visible, []), "Prestation");
});

test("multi-selection is default-allowed up to the maximum, minus the explicit exceptions", () => {
  // Domain version 15 — the server publishes only the *exceptions*: one
  // membership taken off the menu, one with a custom duration. Everything
  // else is bookable without being listed.
  const combinations = [
    { key: "eyeliner+lips", serviceKeys: ["eyeliner", "lips"], durationMinutes: null, bookable: false },
    { key: "brows+lips", serviceKeys: ["brows", "lips"], durationMinutes: 75, bookable: true },
  ];
  const catalogue = [
    { key: "brows", label: "Sourcils", description: "", durationMinutes: 90, imageSrc: null },
    { key: "lips", label: "Lèvres", description: "", durationMinutes: 60, imageSrc: null },
    { key: "freckles", label: "Taches", description: "", durationMinutes: 20, imageSrc: null },
    { key: "eyeliner", label: "Eye-liner", description: "", durationMinutes: 45, imageSrc: null },
  ];
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "toggle-service", serviceKey: "lips", maxServices: 2 });
  state = reservationFlowReducer(state, { type: "toggle-service", serviceKey: "brows", maxServices: 2 });
  assert.deepEqual(state.serviceKeys, ["lips", "brows"]);
  // A third pick beyond the maximum is ignored, not truncated.
  const atMax = reservationFlowReducer(state, { type: "toggle-service", serviceKey: "freckles", maxServices: 2 });
  assert.equal(atMax, state);

  // Order of selection does not matter: B+A resolves the stored A+B row…
  assert.equal(resolveCombination(combinations, state.serviceKeys)?.key, "brows+lips");
  assert.equal(selectionIsBookable(combinations, state.serviceKeys, 2), true);
  // …and its stored custom duration wins over the 150-minute sum.
  assert.equal(selectionDurationMinutes(catalogue, combinations, state.serviceKeys), 75);

  // A pair the server never stored is bookable by default, for the sum.
  assert.equal(resolveCombination(combinations, ["brows", "freckles"]), null);
  assert.equal(selectionIsBookable(combinations, ["brows", "freckles"], 2), true);
  assert.equal(selectionDurationMinutes(catalogue, combinations, ["brows", "freckles"]), 110);

  // The explicitly disabled pair is the only refusal — in either order.
  assert.equal(combinationIsDisabled(combinations, ["lips", "eyeliner"]), true);
  assert.equal(selectionIsBookable(combinations, ["eyeliner", "lips"], 2), false);

  // After one pick, every other service stays selectable unless its exact
  // pair with it was disabled; once the maximum is reached, none is.
  assert.equal(canAddService(combinations, ["eyeliner"], "freckles", 2), true);
  assert.equal(canAddService(combinations, ["eyeliner"], "lips", 2), false);
  assert.equal(canAddService(combinations, ["lips", "brows"], "freckles", 2), false);
  assert.equal(canAddService(combinations, ["lips", "brows"], "brows", 2), true);
  // A maximum of three applies the same rule incrementally: the third
  // service is refused only when the whole trio is the disabled set.
  assert.equal(canAddService(combinations, ["lips", "brows"], "freckles", 3), true);
  assert.equal(
    canAddService(
      [{ key: "brows+freckles+lips", serviceKeys: ["brows", "freckles", "lips"], durationMinutes: null, bookable: false }],
      ["lips", "brows"],
      "freckles",
      3,
    ),
    false,
  );

  assert.equal(selectionIsBookable(combinations, state.serviceKeys, 1), false);
  assert.equal(selectionIsBookable([], [], 2), false);
  assert.equal(selectionIsBookable([], ["brows"], 1), true);

  // Toggling one off clears downstream choices like a service change does.
  state = reservationFlowReducer(state, { type: "received", availability: availability([slot]) });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "toggle-service", serviceKey: "lips", maxServices: 2 });
  assert.deepEqual(state.serviceKeys, ["brows"]);
  assert.equal(state.selectedSlot, null);
  assert.deepEqual(state.slots, []);
  assert.equal(state.phase, "selecting");
});

test("changing service or date clears all downstream choices", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "received", availability: availability([slot]) });
  state = reservationFlowReducer(state, { type: "select-date", date: slot.localDate });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  assert.equal(state.selectedSlot?.startsAtUtc, slot.startsAtUtc);

  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "lips" });
  assert.equal(state.selectedDate, null);
  assert.equal(state.selectedSlot, null);
  assert.deepEqual(state.slots, []);

  state = reservationFlowReducer(state, { type: "select-date", date: "2026-08-25" });
  assert.equal(state.selectedSlot, null);
});

test("refresh preserves the exact returned instant and clears a stale slot with an explanation", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "received", availability: availability([slot]) });
  state = reservationFlowReducer(state, { type: "select-date", date: slot.localDate });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "received", availability: availability([slot]) });
  assert.deepEqual(state.selectedSlot, slot);

  state = reservationFlowReducer(state, { type: "received", availability: availability([]) });
  assert.equal(state.selectedSlot, null);
  assert.match(state.notice ?? "", /plus disponible/);
});

test("navigation clears date and slot state before the new authoritative response", () => {
  let state: ReservationFlowState = { ...initialReservationState("2026-08-21"), selectedDate: slot.localDate, selectedSlot: slot, slots: [slot] };
  state = reservationFlowReducer(state, {
    type: "navigate",
    fromDate: "2026-08-28",
    untilDate: "2026-09-03",
  });
  assert.equal(state.selectedDate, null);
  assert.equal(state.selectedSlot, null);
  assert.deepEqual(state.slots, []);
});

test("customer validation covers required identity and optional limits, and requires no consent", () => {
  assert.deepEqual(Object.keys(validateCustomerDraft({
    firstName: "",
    lastName: "",
    email: "not-an-email",
    phone: "x".repeat(33),
    note: "x".repeat(2001),
  })).sort(), ["email", "firstName", "lastName", "note", "phone"]);

  // ESZ-161: the phone and the "précision" stay optional — an empty value
  // is never an error — and no acceptance is asked for.
  const draft = { firstName: "Cliente", lastName: "Exemple", email: "cliente@example.test", phone: "", note: "" };
  assert.deepEqual(validateCustomerDraft(draft), {});
  assert.equal("consentAccepted" in draft, false);

  // ESZ-160: first and last names fail independently, and each part is
  // capped so the composed `customerName` fits the API's 160 characters.
  assert.deepEqual(Object.keys(validateCustomerDraft({
    firstName: "Cliente",
    lastName: " ",
    email: "cliente@example.test",
    phone: "",
    note: "",
  })), ["lastName"]);
  assert.deepEqual(Object.keys(validateCustomerDraft({
    firstName: "x".repeat(CUSTOMER_NAME_PART_MAX_LENGTH + 1),
    lastName: "Exemple",
    email: "cliente@example.test",
    phone: "",
    note: "",
  })), ["firstName"]);
  assert.equal(
    composeCustomerName({
      firstName: "x".repeat(CUSTOMER_NAME_PART_MAX_LENGTH),
      lastName: "y".repeat(CUSTOMER_NAME_PART_MAX_LENGTH),
    }).length <= 160,
    true,
  );

  assert.deepEqual(validateCustomerDraft({
    firstName: " Cliente ",
    lastName: " Exemple ",
    email: " cliente@example.test ",
    phone: "",
    note: "",
  }), {});
});

test("the creation payload preserves the exact slot instant and normalizes optional fields", () => {
  const request = createBookingRequest(["brows"], slot, {
    firstName: " Cliente ",
    lastName: " Exemple ",
    email: " cliente@example.test ",
    phone: " ",
    note: " question ",
  });
  assert.deepEqual(request, {
    serviceKeys: ["brows"],
    startsAtUtc: slot.startsAtUtc,
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: null,
    customerNote: "question",
    // ESZ-161: the id of the catalog entry whose text the form displayed.
    privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
  });
  // No consent boolean and no consent notice travel any more.
  assert.equal("consentAccepted" in request, false);
  assert.equal("consentNoticeId" in request, false);
});

test("the creation request names exactly the privacy notice the form renders", () => {
  // The pair is the point of ESZ-161: `reservation-details.tsx` renders
  // `bookingPrivacyCurrentNotice.content` and the request sends
  // `bookingPrivacyCurrentNotice.id`, so the server can store which
  // information was shown. Notice text is never part of the request.
  const request = createBookingRequest(["brows"], slot, {
    firstName: "Cliente",
    lastName: "Exemple",
    email: "cliente@example.test",
    phone: "",
    note: "",
  });
  assert.equal(request.privacyNoticeId, bookingPrivacyCurrentNotice.id);
  assert.equal(request.privacyNoticeId, BOOKING_PRIVACY_CURRENT_NOTICE_ID);
  assert.equal("privacyNoticeText" in request, false);
  assert.equal(Object.keys(request).includes("privacyNoticeText"), false);
});

test("review, confirmed success and ordinary failure preserve customer and appointment facts", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "update-customer", field: "firstName", value: "Cliente" });
  state = reservationFlowReducer(state, { type: "update-customer", field: "lastName", value: "Exemple" });
  state = reservationFlowReducer(state, { type: "show-review" });
  assert.equal(state.phase, "review");
  state = reservationFlowReducer(state, { type: "submit-start" });
  assert.equal(state.phase, "submitting");
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: { kind: "server", message: "Serveur indisponible" },
  });
  assert.equal(state.phase, "review");
  assert.equal(state.customer.firstName, "Cliente");
  assert.equal(state.customer.lastName, "Exemple");
  assert.equal(state.selectedSlot?.startsAtUtc, slot.startsAtUtc);

  state = reservationFlowReducer(state, { type: "submit-start" });
  state = reservationFlowReducer(state, {
    type: "submit-success",
    confirmation: {
      // ESZ-161: a current XXXX-XXXX reference.
      reference: "XG73-UVK9",
      serviceKey: "brows",
      serviceKeys: ["brows"],
      combinationKey: null,
      state: "confirmed",
      startsAtUtc: slot.startsAtUtc,
      endsAtUtc: slot.endsAtUtc,
    },
  });
  assert.equal(state.phase, "confirmed");
  assert.equal(state.confirmation?.reference, "XG73-UVK9");
});

test("last-second unavailability clears only the stale slot and preserves safe input", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-date", date: slot.localDate });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "update-customer", field: "email", value: "cliente@example.test" });
  state = reservationFlowReducer(state, {
    type: "booking-slot-unavailable",
    message: "Ce créneau vient d’être réservé.",
  });

  assert.equal(state.selectedSlot, null);
  assert.equal(state.selectedDate, slot.localDate);
  assert.equal(state.customer.email, "cliente@example.test");
  assert.equal(state.phase, "selecting");
  assert.match(state.notice ?? "", /vient d’être réservé/);
});

// --- ESZ-136: rate-limited availability and creation -----------------------

test("an availability 429 is a distinct error that closes the refresh gate until its deadline", () => {
  const receivedAt = 1_000_000;
  const deadline = retryAllowedAtEpochMs(receivedAt, 30);
  assert.equal(deadline, receivedAt + 30_000);

  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, {
    type: "rate-limited",
    message: BOOKING_API_MESSAGES.rateLimited,
    retryAtEpochMs: deadline,
  });

  // Distinct copy, error state, and a closed retry gate: an immediate refresh
  // attempt is refused until the deadline passes.
  assert.equal(state.availabilityStatus, "error");
  assert.equal(state.error, BOOKING_API_MESSAGES.rateLimited);
  assert.equal(state.availabilityRetryAtEpochMs, deadline);
  assert.equal(isRetryBlocked(state.availabilityRetryAtEpochMs, receivedAt + 1), true);

  // Once the trusted delay has elapsed the retry is allowed again…
  assert.equal(isRetryBlocked(state.availabilityRetryAtEpochMs, deadline), false);

  // …and the state did not move by itself: no automatic request fired, the
  // error is still displayed, and only a manual request starts the reload.
  assert.equal(state.availabilityStatus, "error");
  state = reservationFlowReducer(state, { type: "request" });
  assert.equal(state.availabilityStatus, "loading");
  assert.equal(state.availabilityRetryAtEpochMs, null);
});

test("an availability 429 without a usable Retry-After is rate-limited but never blocked", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, {
    type: "rate-limited",
    message: BOOKING_API_MESSAGES.rateLimited,
    retryAtEpochMs: null,
  });

  assert.equal(state.availabilityStatus, "error");
  assert.equal(state.error, BOOKING_API_MESSAGES.rateLimited);
  assert.equal(state.availabilityRetryAtEpochMs, null);
  assert.equal(isRetryBlocked(state.availabilityRetryAtEpochMs, Date.now()), false);
});

test("a generic availability failure never leaves a retry gate behind", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, {
    type: "rate-limited",
    message: BOOKING_API_MESSAGES.rateLimited,
    retryAtEpochMs: 5_000_000,
  });
  state = reservationFlowReducer(state, {
    type: "failed",
    message: "Le service de réservation n’a pas pu traiter cette demande.",
  });

  assert.equal(state.availabilityStatus, "error");
  assert.equal(state.availabilityRetryAtEpochMs, null);
  assert.doesNotMatch(state.error ?? "", /demandes ont été envoyées/);
});

test("a 429 booking creation keeps the review state, the slot, the customer and a trusted gate", () => {
  const receivedAt = 2_000_000;
  const deadline = retryAllowedAtEpochMs(receivedAt, 120);
  assert.equal(deadline, receivedAt + 120_000);

  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "update-customer", field: "firstName", value: "Cliente" });
  state = reservationFlowReducer(state, { type: "update-customer", field: "lastName", value: "Exemple" });
  state = reservationFlowReducer(state, { type: "update-customer", field: "email", value: "cliente@example.test" });
  state = reservationFlowReducer(state, { type: "show-review" });
  state = reservationFlowReducer(state, { type: "submit-start" });
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: {
      kind: "rate-limited",
      message: BOOKING_API_MESSAGES.rateLimited,
      retryAfterSeconds: 120,
    },
    retryAtEpochMs: deadline,
  });

  // The refusal is not a slot conflict, not a validation problem and not a
  // server failure: the visitor stays on the review step with everything they
  // typed and the slot they chose, waiting for a later manual retry.
  assert.equal(state.phase, "review");
  assert.equal(state.submissionError?.kind, "rate-limited");
  if (state.submissionError?.kind !== "rate-limited") return;
  assert.equal(state.submissionError.retryAfterSeconds, 120);
  assert.equal(state.selectedSlot?.startsAtUtc, slot.startsAtUtc);
  assert.equal(state.customer.firstName, "Cliente");
  assert.equal(state.customer.lastName, "Exemple");
  assert.equal(state.customer.email, "cliente@example.test");
  assert.equal(state.submissionRetryAtEpochMs, deadline);
  assert.equal(isRetryBlocked(state.submissionRetryAtEpochMs, receivedAt + 1), true);
  assert.equal(isRetryBlocked(state.submissionRetryAtEpochMs, deadline), false);
  assert.equal(isRetryBlocked(state.submissionRetryAtEpochMs, deadline + 1), false);

  // A fresh manual attempt is then allowed and clears the gate.
  state = reservationFlowReducer(state, { type: "submit-start" });
  assert.equal(state.submissionRetryAtEpochMs, null);
  assert.equal(state.phase, "submitting");
});

test("a booking creation 429 without a usable Retry-After never fabricates a gate", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: {
      kind: "rate-limited",
      message: BOOKING_API_MESSAGES.rateLimited,
      retryAfterSeconds: null,
    },
    retryAtEpochMs: null,
  });

  assert.equal(state.phase, "review");
  assert.equal(state.submissionError?.kind, "rate-limited");
  assert.equal(state.submissionRetryAtEpochMs, null);
});

test("non-rate-limited creation failures leave the retry control open", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: { kind: "server", message: "Le serveur n’a pas pu confirmer le rendez-vous." },
  });
  assert.equal(state.submissionRetryAtEpochMs, null);

  state = reservationFlowReducer(state, { type: "submit-failed", failure: {
    kind: "uncertain",
    message: "Nous n’avons pas reçu de confirmation.",
  } });
  assert.equal(state.submissionRetryAtEpochMs, null);
  assert.equal(state.phase, "review");
});

test("editing or navigating clears the rate-limited gates with the failure they belonged to", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, {
    type: "rate-limited",
    message: BOOKING_API_MESSAGES.rateLimited,
    retryAtEpochMs: 5_000_000,
  });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: {
      kind: "rate-limited",
      message: BOOKING_API_MESSAGES.rateLimited,
      retryAfterSeconds: 30,
    },
    retryAtEpochMs: 6_000_000,
  });
  assert.equal(state.availabilityRetryAtEpochMs, 5_000_000);
  assert.equal(state.submissionRetryAtEpochMs, 6_000_000);

  state = reservationFlowReducer(state, {
    type: "navigate",
    fromDate: "2026-08-28",
    untilDate: "2026-09-03",
  });
  assert.equal(state.availabilityRetryAtEpochMs, null);
  assert.equal(state.submissionRetryAtEpochMs, null);
});
