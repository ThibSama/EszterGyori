import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import { BOOKING_API_MESSAGES } from "../app/lib/booking-api";
import {
  isRetryBlocked,
  retryAllowedAtEpochMs,
} from "../app/lib/retry-after";
import type { BookingAvailability, BookingSlot } from "../app/lib/booking-api";
import {
  RESERVATION_HORIZON_DAYS,
  activeEditorialServices,
  addCivilDays,
  createBookingRequest,
  initialReservationState,
  parisToday,
  rangeFrom,
  reservationFlowReducer,
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

test("only server-active canonical services are merged with editorial content", () => {
  const visible = activeEditorialServices(defaultSiteContent.services.items, [
    { key: "lips", label: "Lèvres réservation", durationMinutes: 45 },
    { key: "brows", label: "Sourcils réservation", durationMinutes: 30 },
  ]);

  assert.deepEqual(visible.map(({ editorial }) => editorial.id), ["brows", "lips"]);
  assert.equal(visible[0].editorial.title, "Sourcils");
  assert.equal(visible[0].booking.durationMinutes, 30);
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

test("customer validation covers required identity, optional limits and explicit consent", () => {
  assert.deepEqual(Object.keys(validateCustomerDraft({
    name: "",
    email: "not-an-email",
    phone: "x".repeat(33),
    note: "x".repeat(2001),
    consentAccepted: false,
  })).sort(), ["consentAccepted", "email", "name", "note", "phone"]);

  assert.deepEqual(validateCustomerDraft({
    name: " Cliente Exemple ",
    email: " cliente@example.test ",
    phone: "",
    note: "",
    consentAccepted: true,
  }), {});
});

test("the creation payload preserves the exact slot instant and normalizes optional fields", () => {
  const request = createBookingRequest("brows", slot, {
    name: " Cliente Exemple ",
    email: " cliente@example.test ",
    phone: " ",
    note: " question ",
    consentAccepted: true,
  });
  assert.deepEqual(request, {
    serviceKey: "brows",
    startsAtUtc: slot.startsAtUtc,
    customerName: "Cliente Exemple",
    customerEmail: "cliente@example.test",
    customerPhone: null,
    customerNote: "question",
    consentAccepted: true,
  });
});

test("review, confirmed success and ordinary failure preserve customer and appointment facts", () => {
  let state = initialReservationState("2026-08-21");
  state = reservationFlowReducer(state, { type: "select-service", serviceKey: "brows" });
  state = reservationFlowReducer(state, { type: "select-slot", slot });
  state = reservationFlowReducer(state, { type: "update-customer", field: "name", value: "Cliente Exemple" });
  state = reservationFlowReducer(state, { type: "show-review" });
  assert.equal(state.phase, "review");
  state = reservationFlowReducer(state, { type: "submit-start" });
  assert.equal(state.phase, "submitting");
  state = reservationFlowReducer(state, {
    type: "submit-failed",
    failure: { kind: "server", message: "Serveur indisponible" },
  });
  assert.equal(state.phase, "review");
  assert.equal(state.customer.name, "Cliente Exemple");
  assert.equal(state.selectedSlot?.startsAtUtc, slot.startsAtUtc);

  state = reservationFlowReducer(state, { type: "submit-start" });
  state = reservationFlowReducer(state, {
    type: "submit-success",
    confirmation: {
      reference: "bk_00000000000000000000000000000000",
      serviceKey: "brows",
      state: "confirmed",
      startsAtUtc: slot.startsAtUtc,
      endsAtUtc: slot.endsAtUtc,
    },
  });
  assert.equal(state.phase, "confirmed");
  assert.equal(state.confirmation?.reference, "bk_00000000000000000000000000000000");
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
  state = reservationFlowReducer(state, { type: "update-customer", field: "name", value: "Cliente Exemple" });
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
  assert.equal(state.customer.name, "Cliente Exemple");
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
