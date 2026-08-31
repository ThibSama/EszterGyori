import type { BookableServiceKey, ServiceItemContent } from "@eszter/contracts";
import type {
  BookingAvailability,
  BookingCreationFailure,
  BookingSlot,
  PublicBookableService,
  PublicBookingConfirmation,
  PublicBookingRequest,
} from "./booking-api";

export const RESERVATION_RANGE_DAYS = 7;
export const RESERVATION_HORIZON_DAYS = 90;

export function parisToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day + days));
  return instant.toISOString().slice(0, 10);
}

export function rangeFrom(start: string): { fromDate: string; untilDate: string } {
  return { fromDate: start, untilDate: addCivilDays(start, RESERVATION_RANGE_DAYS - 1) };
}

export function datesBetween(fromDate: string, untilDate: string): string[] {
  const dates: string[] = [];
  for (let date = fromDate; date <= untilDate; date = addCivilDays(date, 1)) dates.push(date);
  return dates;
}

export function activeEditorialServices(
  editorial: ServiceItemContent[],
  active: PublicBookableService[],
) {
  const activeByKey = new Map(active.map((service) => [service.key, service]));
  return editorial
    .filter((service) => activeByKey.has(service.id))
    .map((service) => ({ editorial: service, booking: activeByKey.get(service.id)! }));
}

export interface ReservationFlowState {
  serviceKey: BookableServiceKey | null;
  fromDate: string;
  untilDate: string;
  selectedDate: string | null;
  selectedSlot: BookingSlot | null;
  slots: BookingSlot[];
  availabilityStatus: "idle" | "loading" | "ready" | "error";
  error: string | null;
  notice: string | null;
  requestVersion: number;
  customer: CustomerDraft;
  customerErrors: CustomerErrors;
  phase: "selecting" | "details" | "review" | "submitting" | "confirmed";
  submissionError: BookingCreationFailure | null;
  confirmation: PublicBookingConfirmation | null;
}

export interface CustomerDraft {
  name: string;
  email: string;
  phone: string;
  note: string;
  consentAccepted: boolean;
}

export type CustomerField = keyof CustomerDraft;
export type CustomerErrors = Partial<Record<CustomerField, string>>;

export type ReservationFlowAction =
  | { type: "select-service"; serviceKey: BookableServiceKey }
  | { type: "navigate"; fromDate: string; untilDate: string }
  | { type: "select-date"; date: string }
  | { type: "select-slot"; slot: BookingSlot }
  | { type: "update-customer"; field: CustomerField; value: string | boolean }
  | { type: "customer-invalid"; errors: CustomerErrors }
  | { type: "show-review" }
  | { type: "edit-details" }
  | { type: "submit-start" }
  | { type: "submit-success"; confirmation: PublicBookingConfirmation }
  | { type: "submit-failed"; failure: BookingCreationFailure }
  | { type: "booking-slot-unavailable"; message: string }
  | { type: "request" }
  | { type: "received"; availability: BookingAvailability }
  | { type: "failed"; message: string };

export function initialReservationState(today: string): ReservationFlowState {
  return {
    serviceKey: null,
    ...rangeFrom(today),
    selectedDate: null,
    selectedSlot: null,
    slots: [],
    availabilityStatus: "idle",
    error: null,
    notice: null,
    requestVersion: 0,
    customer: { name: "", email: "", phone: "", note: "", consentAccepted: false },
    customerErrors: {},
    phase: "selecting",
    submissionError: null,
    confirmation: null,
  };
}

export function validateCustomerDraft(customer: CustomerDraft): CustomerErrors {
  const errors: CustomerErrors = {};
  const name = customer.name.trim();
  const email = customer.email.trim();
  const phone = customer.phone.trim();
  const note = customer.note.trim();
  if (name.length < 1 || name.length > 160) {
    errors.name = "Indiquez votre nom (160 caractères maximum).";
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Indiquez une adresse email valide.";
  }
  if (phone.length > 32) errors.phone = "Le numéro doit contenir 32 caractères maximum.";
  if (note.length > 2000) errors.note = "La note doit contenir 2 000 caractères maximum.";
  if (!customer.consentAccepted) {
    errors.consentAccepted = "Votre accord est nécessaire pour demander ce rendez-vous.";
  }
  return errors;
}

export function createBookingRequest(
  serviceKey: BookableServiceKey,
  slot: BookingSlot,
  customer: CustomerDraft,
): PublicBookingRequest {
  return {
    serviceKey,
    startsAtUtc: slot.startsAtUtc,
    customerName: customer.name.trim(),
    customerEmail: customer.email.trim(),
    customerPhone: customer.phone.trim() || null,
    customerNote: customer.note.trim() || null,
    consentAccepted: true,
  };
}

export function reservationFlowReducer(
  state: ReservationFlowState,
  action: ReservationFlowAction,
): ReservationFlowState {
  switch (action.type) {
    case "select-service":
      return {
        ...state,
        serviceKey: action.serviceKey,
        selectedDate: null,
        selectedSlot: null,
        slots: [],
        availabilityStatus: "idle",
        error: null,
        notice: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
      };
    case "navigate":
      return {
        ...state,
        fromDate: action.fromDate,
        untilDate: action.untilDate,
        selectedDate: null,
        selectedSlot: null,
        slots: [],
        availabilityStatus: "idle",
        error: null,
        notice: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
      };
    case "select-date":
      return {
        ...state,
        selectedDate: action.date,
        selectedSlot: null,
        notice: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
      };
    case "select-slot":
      return {
        ...state,
        selectedSlot: action.slot,
        notice: null,
        phase: "details",
        submissionError: null,
        confirmation: null,
      };
    case "update-customer":
      return {
        ...state,
        customer: { ...state.customer, [action.field]: action.value },
        customerErrors: { ...state.customerErrors, [action.field]: undefined },
        submissionError: null,
      };
    case "customer-invalid":
      return { ...state, customerErrors: action.errors, phase: "details" };
    case "show-review":
      return { ...state, customerErrors: {}, phase: "review", submissionError: null };
    case "edit-details":
      return { ...state, phase: "details", submissionError: null };
    case "submit-start":
      return { ...state, phase: "submitting", submissionError: null };
    case "submit-success":
      return {
        ...state,
        phase: "confirmed",
        submissionError: null,
        confirmation: action.confirmation,
      };
    case "submit-failed":
      return {
        ...state,
        phase: action.failure.kind === "validation" ? "details" : "review",
        submissionError: action.failure,
      };
    case "booking-slot-unavailable":
      return {
        ...state,
        selectedSlot: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
        notice: action.message,
      };
    case "request":
      return {
        ...state,
        availabilityStatus: "loading",
        error: null,
        requestVersion: state.requestVersion + 1,
      };
    case "received": {
      const exactSlotStillExists = state.selectedSlot
        ? action.availability.slots.some(
            (slot) => slot.startsAtUtc === state.selectedSlot?.startsAtUtc,
          )
        : true;
      return {
        ...state,
        fromDate: action.availability.fromDate,
        untilDate: action.availability.untilDate,
        slots: action.availability.slots,
        selectedSlot: exactSlotStillExists ? state.selectedSlot : null,
        phase: exactSlotStillExists ? state.phase : "selecting",
        availabilityStatus: "ready",
        error: null,
        notice: exactSlotStillExists
          ? state.notice
          : "Ce créneau n’est plus disponible. Choisissez un nouvel horaire.",
      };
    }
    case "failed":
      return { ...state, availabilityStatus: "error", error: action.message };
  }
}
