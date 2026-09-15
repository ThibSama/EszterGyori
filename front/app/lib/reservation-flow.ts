import { BOOKING_PRIVACY_CURRENT_NOTICE_ID } from "@eszter/contracts";
import type { BookableServiceKey } from "@eszter/contracts";
import type {
  BookingAvailability,
  BookingCreationFailure,
  BookingSlot,
  PublicBookableCombination,
  PublicBookableService,
  PublicBookingConfirmation,
  PublicBookingRequest,
} from "./booking-api";
import { sameServiceSet } from "./booking-api";

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

/**
 * ESZ-149 — the services the reservation page offers are exactly what the
 * catalog served, in catalog order. There is no matching against the CMS's
 * `services.items` any more: the catalog carries the name, description and
 * image itself, and a service the administrator adds or archives appears or
 * disappears here without the published content knowing about it.
 *
 * Defensive de-duplication only: a malformed response that repeated a key
 * would otherwise render one service twice and mis-key the list.
 */
export function bookableServicesToOffer(
  active: PublicBookableService[],
): PublicBookableService[] {
  const seen = new Set<string>();
  return active.filter((service) => {
    if (seen.has(service.key)) return false;
    seen.add(service.key);
    return true;
  });
}

/**
 * The catalog names of the selected services, in the order they were chosen,
 * joined with " + " — for the summary and the confirmation. "Prestation"
 * while nothing is selected.
 */
export function selectedServiceLabel(
  services: PublicBookableService[],
  serviceKeys: readonly BookableServiceKey[],
): string {
  const labels = serviceKeys.map(
    (serviceKey) => services.find((service) => service.key === serviceKey)?.label ?? serviceKey,
  );
  return labels.length === 0 ? "Prestation" : labels.join(" + ");
}

/**
 * ESZ-150, corrected in domain version 15 — the stored *exception* that
 * governs a selection of two or more services, from the short list of
 * overrides the server published. `null` means there is none, which is the
 * normal case: the selection is then bookable by default for the sum of its
 * component durations. The server re-decides regardless, through the same
 * rule.
 */
export function resolveCombination(
  combinations: readonly PublicBookableCombination[],
  serviceKeys: readonly BookableServiceKey[],
): PublicBookableCombination | null {
  if (serviceKeys.length < 2) return null;
  return combinations.find((combination) => sameServiceSet(combination.serviceKeys, serviceKeys)) ?? null;
}

/**
 * Whether exactly this set of services was explicitly taken off the menu.
 * Everything not disabled is offered, so this is the only refusal the
 * selector applies besides the configured maximum.
 */
export function combinationIsDisabled(
  combinations: readonly PublicBookableCombination[],
  serviceKeys: readonly BookableServiceKey[],
): boolean {
  return resolveCombination(combinations, serviceKeys)?.bookable === false;
}

/**
 * Whether a selection can be sent for availability: one active service, or
 * two to `maxServices` services that were not explicitly disabled together.
 * Everything else is a selection in progress, not a request.
 */
export function selectionIsBookable(
  combinations: readonly PublicBookableCombination[],
  serviceKeys: readonly BookableServiceKey[],
  maxServices: number,
): boolean {
  if (serviceKeys.length === 0 || serviceKeys.length > maxServices) return false;
  return serviceKeys.length === 1 || !combinationIsDisabled(combinations, serviceKeys);
}

/**
 * Whether the visitor may add `serviceKey` to what is already selected: the
 * resulting *complete* set must stay within the maximum and must not be an
 * explicitly disabled combination. Applied incrementally, this is the same
 * rule at a maximum of two and of four — a third service stays offered only
 * while the whole trio it would make is still on the menu.
 */
export function canAddService(
  combinations: readonly PublicBookableCombination[],
  serviceKeys: readonly BookableServiceKey[],
  serviceKey: BookableServiceKey,
  maxServices: number,
): boolean {
  if (serviceKeys.includes(serviceKey)) return true;
  if (serviceKeys.length >= maxServices) return false;
  return !combinationIsDisabled(combinations, [...serviceKeys, serviceKey]);
}

/**
 * The duration the visitor will be told: the single service's, the stored
 * custom duration of this exact combination, or — by default — the sum of
 * the selected services' durations. `null` while the selection names a
 * service the catalog did not serve.
 */
export function selectionDurationMinutes(
  services: readonly PublicBookableService[],
  combinations: readonly PublicBookableCombination[],
  serviceKeys: readonly BookableServiceKey[],
): number | null {
  if (serviceKeys.length === 0) return null;
  if (serviceKeys.length === 1) {
    return services.find((service) => service.key === serviceKeys[0])?.durationMinutes ?? null;
  }
  const custom = resolveCombination(combinations, serviceKeys)?.durationMinutes ?? null;
  if (custom !== null) return custom;
  let sum = 0;
  for (const serviceKey of serviceKeys) {
    const service = services.find((candidate) => candidate.key === serviceKey);
    if (service === undefined) return null;
    sum += service.durationMinutes;
  }
  return sum;
}

export interface ReservationFlowState {
  /**
   * ESZ-150 — the selected services in the order they were chosen; empty
   * while none is. The single-service flow is a one-element list.
   */
  serviceKeys: BookableServiceKey[];
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
  /**
   * ESZ-136 — epoch (ms) at which the availability retry control opens again,
   * or `null` when no trusted `Retry-After` delay is running. Set only by a
   * 429 rate-limit refusal of an availability load; everything that moves the
   * availability state (a fresh request, a response, a generic failure, a
   * service or week change) clears it.
   */
  availabilityRetryAtEpochMs: number | null;
  /**
   * ESZ-136 — same deadline, for the booking-submission retry control. Set
   * only by a 429 rate-limit refusal of the creation request; cleared by
   * anything that resets the submission (a new attempt, a success, editing).
   */
  submissionRetryAtEpochMs: number | null;
}

export interface CustomerDraft {
  /**
   * ESZ-160 — the visitor's first and last names are entered, validated and
   * reviewed separately; the booking API still receives one `customerName`
   * (see `composeCustomerName`), so the split lives only in this form.
   */
  firstName: string;
  lastName: string;
  email: string;
  /** Optional; used only for transactional messages about the appointment. */
  phone: string;
  /**
   * ESZ-161 — "Précision sur le rendez-vous", optional. Free text about the
   * appointment itself; the form warns against entering health, medical or
   * other sensitive data. There is deliberately no consent field: a booking
   * rests on the requested service, and the form shows information instead.
   */
  note: string;
}

export type CustomerField = keyof CustomerDraft;
export type CustomerErrors = Partial<Record<CustomerField, string>>;

export type ReservationFlowAction =
  /** Replaces the selection with this one service (a deep link, or a single-service catalog). */
  | { type: "select-service"; serviceKey: BookableServiceKey }
  /**
   * ESZ-150 — adds or removes one service. Adding beyond `maxServices` is
   * ignored: the control is disabled, and this closes the same-tick gap.
   */
  | { type: "toggle-service"; serviceKey: BookableServiceKey; maxServices: number }
  | { type: "navigate"; fromDate: string; untilDate: string }
  | { type: "select-date"; date: string }
  | { type: "select-slot"; slot: BookingSlot }
  | { type: "update-customer"; field: CustomerField; value: string }
  | { type: "customer-invalid"; errors: CustomerErrors }
  | { type: "show-review" }
  | { type: "edit-details" }
  | { type: "submit-start" }
  | { type: "submit-success"; confirmation: PublicBookingConfirmation }
  | {
      type: "submit-failed";
      failure: BookingCreationFailure;
      /**
       * ESZ-136: the trusted-retry deadline (epoch ms) computed when the 429
       * was received. Present only for a `rate-limited` failure whose
       * `Retry-After` was usable; absent or `null` otherwise.
       */
      retryAtEpochMs?: number | null;
    }
  | { type: "booking-slot-unavailable"; message: string }
  | { type: "request" }
  | { type: "received"; availability: BookingAvailability }
  | { type: "failed"; message: string }
  /**
   * ESZ-136: an availability load was refused with 429 `RATE_LIMITED`.
   * `retryAtEpochMs` is the trusted-retry deadline computed when the refusal
   * was received, or `null` when no usable `Retry-After` arrived.
   */
  | { type: "rate-limited"; message: string; retryAtEpochMs: number | null };

export function initialReservationState(today: string): ReservationFlowState {
  return {
    serviceKeys: [],
    ...rangeFrom(today),
    selectedDate: null,
    selectedSlot: null,
    slots: [],
    availabilityStatus: "idle",
    error: null,
    notice: null,
    requestVersion: 0,
    customer: { firstName: "", lastName: "", email: "", phone: "", note: "" },
    customerErrors: {},
    phase: "selecting",
    submissionError: null,
    confirmation: null,
    availabilityRetryAtEpochMs: null,
    submissionRetryAtEpochMs: null,
  };
}

/**
 * ESZ-160 — each name part is capped so that the composed `customerName`
 * (first, a space, last) always fits the API's 160-character limit.
 */
export const CUSTOMER_NAME_PART_MAX_LENGTH = 79;

/**
 * The single `customerName` the booking API expects, composed from the two
 * validated form values: `"Prénom Nom"`.
 */
export function composeCustomerName(customer: Pick<CustomerDraft, "firstName" | "lastName">): string {
  return `${customer.firstName.trim()} ${customer.lastName.trim()}`.trim();
}

export function validateCustomerDraft(customer: CustomerDraft): CustomerErrors {
  const errors: CustomerErrors = {};
  const firstName = customer.firstName.trim();
  const lastName = customer.lastName.trim();
  const email = customer.email.trim();
  const phone = customer.phone.trim();
  const note = customer.note.trim();
  if (firstName.length < 1 || firstName.length > CUSTOMER_NAME_PART_MAX_LENGTH) {
    errors.firstName = `Indiquez votre prénom (${CUSTOMER_NAME_PART_MAX_LENGTH} caractères maximum).`;
  }
  if (lastName.length < 1 || lastName.length > CUSTOMER_NAME_PART_MAX_LENGTH) {
    errors.lastName = `Indiquez votre nom (${CUSTOMER_NAME_PART_MAX_LENGTH} caractères maximum).`;
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Indiquez une adresse email valide.";
  }
  if (phone.length > 32) errors.phone = "Le numéro doit contenir 32 caractères maximum.";
  if (note.length > 2000) errors.note = "La précision doit contenir 2 000 caractères maximum.";
  return errors;
}

export function createBookingRequest(
  serviceKeys: readonly BookableServiceKey[],
  slot: BookingSlot,
  customer: CustomerDraft,
): PublicBookingRequest {
  return {
    serviceKeys: [...serviceKeys],
    startsAtUtc: slot.startsAtUtc,
    customerName: composeCustomerName(customer),
    customerEmail: customer.email.trim(),
    customerPhone: customer.phone.trim() || null,
    customerNote: customer.note.trim() || null,
    // ESZ-161: the id of the privacy-information notice the form displayed
    // — the catalog's current entry — so the server can record exactly which
    // information the customer was shown. Notice text is never sent, and no
    // consent field exists: the booking rests on the requested service.
    privacyNoticeId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
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
        serviceKeys: [action.serviceKey],
        selectedDate: null,
        selectedSlot: null,
        slots: [],
        availabilityStatus: "idle",
        error: null,
        notice: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
        availabilityRetryAtEpochMs: null,
        submissionRetryAtEpochMs: null,
      };
    case "toggle-service": {
      const selected = state.serviceKeys.includes(action.serviceKey);
      if (!selected && state.serviceKeys.length >= action.maxServices) return state;
      return {
        ...state,
        serviceKeys: selected
          ? state.serviceKeys.filter((key) => key !== action.serviceKey)
          : [...state.serviceKeys, action.serviceKey],
        selectedDate: null,
        selectedSlot: null,
        slots: [],
        availabilityStatus: "idle",
        error: null,
        notice: null,
        phase: "selecting",
        submissionError: null,
        confirmation: null,
        availabilityRetryAtEpochMs: null,
        submissionRetryAtEpochMs: null,
      };
    }
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
        availabilityRetryAtEpochMs: null,
        submissionRetryAtEpochMs: null,
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
        submissionRetryAtEpochMs: null,
      };
    case "select-slot":
      return {
        ...state,
        selectedSlot: action.slot,
        notice: null,
        phase: "details",
        submissionError: null,
        confirmation: null,
        submissionRetryAtEpochMs: null,
      };
    case "update-customer":
      return {
        ...state,
        customer: { ...state.customer, [action.field]: action.value },
        customerErrors: { ...state.customerErrors, [action.field]: undefined },
        submissionError: null,
        submissionRetryAtEpochMs: null,
      };
    case "customer-invalid":
      return { ...state, customerErrors: action.errors, phase: "details" };
    case "show-review":
      return {
        ...state,
        customerErrors: {},
        phase: "review",
        submissionError: null,
        submissionRetryAtEpochMs: null,
      };
    case "edit-details":
      return {
        ...state,
        phase: "details",
        submissionError: null,
        submissionRetryAtEpochMs: null,
      };
    case "submit-start":
      return {
        ...state,
        phase: "submitting",
        submissionError: null,
        submissionRetryAtEpochMs: null,
      };
    case "submit-success":
      return {
        ...state,
        phase: "confirmed",
        submissionError: null,
        submissionRetryAtEpochMs: null,
        confirmation: action.confirmation,
      };
    case "submit-failed":
      return {
        ...state,
        phase: action.failure.kind === "validation" ? "details" : "review",
        submissionError: action.failure,
        // Only a 429 refusal carries a trusted retry deadline (ESZ-136); any
        // other failure leaves the retry control open.
        submissionRetryAtEpochMs:
          action.failure.kind === "rate-limited"
            ? (action.retryAtEpochMs ?? null)
            : null,
      };
    case "booking-slot-unavailable":
      return {
        ...state,
        selectedSlot: null,
        phase: "selecting",
        submissionError: null,
        submissionRetryAtEpochMs: null,
        confirmation: null,
        notice: action.message,
      };
    case "request":
      return {
        ...state,
        availabilityStatus: "loading",
        error: null,
        requestVersion: state.requestVersion + 1,
        availabilityRetryAtEpochMs: null,
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
        availabilityRetryAtEpochMs: null,
        notice: exactSlotStillExists
          ? state.notice
          : "Ce créneau n’est plus disponible. Choisissez un nouvel horaire.",
      };
    }
    case "failed":
      return {
        ...state,
        availabilityStatus: "error",
        error: action.message,
        availabilityRetryAtEpochMs: null,
      };
    case "rate-limited":
      return {
        ...state,
        availabilityStatus: "error",
        error: action.message,
        availabilityRetryAtEpochMs: action.retryAtEpochMs,
      };
  }
}
