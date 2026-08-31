import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
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
