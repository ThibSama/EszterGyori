import {
  BOOKING_SERVICE_DESCRIPTION_MAX_LENGTH,
  BOOKING_SERVICE_DURATION_MAX_MINUTES,
  BOOKING_SERVICE_DURATION_MIN_MINUTES,
  BOOKING_SERVICE_LABEL_MAX_LENGTH,
} from "@eszter/contracts";
import type {
  AdminApiFailure,
  AdminBookableService,
  AdminServiceMutation,
} from "./admin-api";

/**
 * The service catalog editor's rules, as data (ESZ-149).
 *
 * Everything the `Prestations` page decides without a server is here, so the
 * tests can assert it without rendering: what a draft is, when it is valid,
 * what mutation it becomes, and what each outcome says to Esther. The
 * component renders these; it does not restate them.
 *
 * The list is deliberately narrow — name, duration, status, actions — and the
 * form edits name, description, duration and image. No price, category,
 * revenue or statistic exists on this surface, and none can: the admin API
 * serves no such field.
 */

export type ServiceStatus = AdminBookableService["status"];

/** What the form holds while a service is being added or edited. */
export interface ServiceDraft {
  /** `null` while adding; the immutable key while editing. */
  key: string | null;
  /** The row's token while editing; `null` while adding. */
  expectedUpdatedAt: string | null;
  label: string;
  description: string;
  /** Kept as typed so an empty or partial number can be shown back, not coerced. */
  durationMinutes: string;
  imageSrc: string | null;
}

export type ServiceDraftField = "label" | "description" | "durationMinutes";
export type ServiceDraftErrors = Partial<Record<ServiceDraftField, string>>;

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  active: "Active",
  archived: "Archivée",
};

export const ADMIN_SERVICES_MESSAGES = {
  loading: "Chargement des prestations…",
  empty: "Aucune prestation pour le moment. Ajoutez la première pour ouvrir la réservation.",
  created: "La prestation a été ajoutée. Elle est proposée à la réservation.",
  updated: "La prestation a été enregistrée.",
  archived: "La prestation a été archivée. Elle n’est plus proposée à la réservation ; les rendez-vous existants sont conservés.",
  restored: "La prestation est de nouveau proposée à la réservation.",
  conflict:
    "Cette prestation a été modifiée ailleurs depuis son chargement. La liste a été actualisée : vérifiez puis recommencez.",
  notFound: "Cette prestation n’existe plus. La liste a été actualisée.",
  forbidden:
    "Le jeton de sécurité a expiré. Il a été actualisé ; confirmez de nouveau l’action.",
  validation:
    "Le serveur a refusé cette prestation. Rien n’a été enregistré : vérifiez le nom, la description, la durée et l’image.",
  archiveConfirm:
    "Elle ne sera plus proposée à la réservation. Les rendez-vous déjà pris sont conservés et restent visibles dans le calendrier.",
} as const;

export const SERVICE_DRAFT_ERRORS = {
  label: `Indiquez un nom (${BOOKING_SERVICE_LABEL_MAX_LENGTH} caractères maximum).`,
  description: `La description doit contenir ${BOOKING_SERVICE_DESCRIPTION_MAX_LENGTH} caractères maximum.`,
  durationMinutes: `Indiquez une durée entière entre ${BOOKING_SERVICE_DURATION_MIN_MINUTES} et ${BOOKING_SERVICE_DURATION_MAX_MINUTES} minutes.`,
} as const;

export function emptyServiceDraft(): ServiceDraft {
  return {
    key: null,
    expectedUpdatedAt: null,
    label: "",
    description: "",
    durationMinutes: "",
    imageSrc: null,
  };
}

export function draftFromService(service: AdminBookableService): ServiceDraft {
  return {
    key: service.key,
    expectedUpdatedAt: service.updatedAt,
    label: service.label,
    description: service.description,
    durationMinutes: String(service.durationMinutes),
    imageSrc: service.imageSrc,
  };
}

/** The same bounds the wire schema and the domain enforce, checked before sending. */
export function validateServiceDraft(draft: ServiceDraft): ServiceDraftErrors {
  const errors: ServiceDraftErrors = {};
  const label = draft.label.trim();
  if (label.length < 1 || label.length > BOOKING_SERVICE_LABEL_MAX_LENGTH) {
    errors.label = SERVICE_DRAFT_ERRORS.label;
  }
  if (draft.description.trim().length > BOOKING_SERVICE_DESCRIPTION_MAX_LENGTH) {
    errors.description = SERVICE_DRAFT_ERRORS.description;
  }
  const duration = parseDuration(draft.durationMinutes);
  if (duration === null) {
    errors.durationMinutes = SERVICE_DRAFT_ERRORS.durationMinutes;
  }
  return errors;
}

/** A whole number of minutes inside the domain bounds, or `null`. */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  if (
    !Number.isSafeInteger(minutes)
    || minutes < BOOKING_SERVICE_DURATION_MIN_MINUTES
    || minutes > BOOKING_SERVICE_DURATION_MAX_MINUTES
  ) {
    return null;
  }
  return minutes;
}

/**
 * The mutation a valid draft becomes: `create` while adding, `update` with the
 * row's token while editing. Returns `null` for an invalid draft so a caller
 * can never send one by accident.
 */
export function mutationFromDraft(draft: ServiceDraft): AdminServiceMutation | null {
  if (Object.keys(validateServiceDraft(draft)).length > 0) return null;
  const duration = parseDuration(draft.durationMinutes);
  if (duration === null) return null;
  const fields = {
    label: draft.label.trim(),
    description: draft.description.trim(),
    durationMinutes: duration,
    imageSrc: draft.imageSrc,
  };
  if (draft.key === null || draft.expectedUpdatedAt === null) {
    return { action: "create", ...fields };
  }
  return {
    action: "update",
    key: draft.key,
    expectedUpdatedAt: draft.expectedUpdatedAt,
    ...fields,
  };
}

/** "1 h 30", "45 min", "2 h" — the same wording the reservation page uses. */
export function formatServiceDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
}

/**
 * The list after a stored service comes back from the server: replaced in
 * place when the key exists, appended when it is new. Catalog order is the
 * server's, so an edit never moves a row and a creation lands last.
 */
export function adoptStoredService(
  services: AdminBookableService[],
  stored: AdminBookableService,
): AdminBookableService[] {
  const index = services.findIndex((service) => service.key === stored.key);
  if (index === -1) return [...services, stored];
  return services.map((service, position) => (position === index ? stored : service));
}

/** How many catalog rows — archived included — point at this managed path. */
export function serviceImageUsages(services: AdminBookableService[], path: string): number {
  return services.filter((service) => service.imageSrc === path).length;
}

/** Whether a failure means "re-read the list before trying again". */
export function isCatalogStale(failure: AdminApiFailure): boolean {
  return failure.kind === "conflict" || failure.kind === "not-found";
}

export function serviceFailureMessage(failure: AdminApiFailure): string {
  switch (failure.kind) {
    case "conflict":
      return ADMIN_SERVICES_MESSAGES.conflict;
    case "not-found":
      return ADMIN_SERVICES_MESSAGES.notFound;
    case "forbidden":
      return ADMIN_SERVICES_MESSAGES.forbidden;
    case "validation":
      return ADMIN_SERVICES_MESSAGES.validation;
    default:
      return failure.message;
  }
}
