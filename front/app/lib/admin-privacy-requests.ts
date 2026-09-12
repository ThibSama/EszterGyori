import {
  BOOKING_REFERENCE_CURRENT_PATTERN,
  BOOKING_REFERENCE_LEGACY_PATTERN,
  PRIVACY_REQUEST_MAX_BOOKING_REFERENCES,
  privacyRequestTypes,
} from "@eszter/contracts";
import type {
  AdminApiFailure,
  AdminPrivacyRectificationEntry,
  AdminPrivacyRequest,
  AdminPrivacyRequestMatch,
  AdminPrivacyRequestScopeBooking,
  AdminPrivacyRequestStatus,
  AdminPrivacyRequestType,
} from "./admin-api";

/**
 * The pure half of the GDPR request centre (ESZ-163): labels, the
 * identification rule, the scope-selection rule and the messages. Nothing
 * here fetches or renders, so the workflow's decisions are testable without
 * a DOM.
 *
 * The five types and the three statuses are the contract's own lists; the
 * French labels are the only thing this module adds to them, and a type or
 * status the contract does not know cannot be labelled.
 */

export const PRIVACY_REQUEST_TYPE_LABELS: Record<AdminPrivacyRequestType, string> = {
  access: "Accès",
  rectification: "Rectification",
  erasure: "Effacement / anonymisation",
  restriction: "Limitation du traitement",
  portability: "Portabilité",
};

/** Ordered as the contract orders them, so the form and the register agree. */
export const PRIVACY_REQUEST_TYPES: readonly AdminPrivacyRequestType[] = privacyRequestTypes;

export const PRIVACY_REQUEST_STATUS_LABELS: Record<AdminPrivacyRequestStatus, string> = {
  received: "Reçue",
  in_progress: "En cours",
  closed: "Clôturée",
};

/** The common flow: type → identification → search → scope review → record. */
export const PRIVACY_REQUEST_STEPS = [
  "type",
  "identification",
  "search",
  "scope",
  "recorded",
] as const;
export type PrivacyRequestStep = (typeof PRIVACY_REQUEST_STEPS)[number];

export const ADMIN_PRIVACY_MESSAGES = {
  identificationInvalid:
    "Saisissez une référence de réservation (XXXX-XXXX ou bk_…) ou une adresse e-mail.",
  referenceNotFound:
    "Aucune réservation active ne correspond à cette référence. Vérifiez-la ou identifiez la personne par son adresse e-mail.",
  emailNoMatch:
    "Aucune réservation active ne correspond à cette adresse e-mail. La demande peut être enregistrée sans réservation concernée.",
  scopePartial:
    "La liste est incomplète : d’autres réservations correspondent à cette adresse. Chargez la suite avant de valider le périmètre.",
  scopeComplete: "Toutes les réservations correspondantes sont affichées.",
  scopeNothingSelected:
    "Cochez les réservations concernées, ou confirmez qu’aucune réservation n’est concernée.",
  recorded: "La demande a été enregistrée dans le registre. Aucune donnée n’a encore été modifiée ni exportée.",
  registerEmpty: "Aucune demande enregistrée pour le moment.",
  registerNotFound: "Cette demande n’existe plus dans le registre.",
  tooManyReferences: `Une demande ne peut pas viser plus de ${PRIVACY_REQUEST_MAX_BOOKING_REFERENCES} réservations.`,
  // ESZ-164 — the execution of the rights.
  exported:
    "L’export a été généré et téléchargé. Il n’est conservé nulle part sur le serveur ; la demande est clôturée.",
  rectified: "Les coordonnées ont été rectifiées sur les réservations retenues. La demande est clôturée.",
  anonymised:
    "Les données personnelles des réservations retenues ont été anonymisées ; les rendez-vous sont maintenus. La demande est clôturée.",
  restricted:
    "Le traitement est limité pour les réservations retenues : aucun rappel ne sera envoyé tant que la limitation n’est pas levée. La demande est clôturée.",
  lifted:
    "La limitation est levée : un e-mail d’information est envoyé à la personne et les rappels encore à venir reprennent. Les rappels dont l’échéance est passée ne sont pas renvoyés.",
  nothingToAct:
    "Aucune réservation de cette demande ne permet cette action (réservations déjà anonymisées ou absentes).",
  staleRectification:
    "Une réservation a été modifiée entre-temps. Rechargez la demande et vérifiez les coordonnées avant de rectifier.",
} as const;

/** The labels the calendar and the detail view show for the two markers (booking-domain privacyRequests.execution). */
export const PRIVACY_BOOKING_MARKER_LABELS = {
  anonymised: "Cliente anonymisée — rendez-vous maintenu",
  restricted: "Traitement limité",
} as const;

/** What the administrator must explicitly acknowledge before the two guarded actions run. */
export const PRIVACY_CONFIRMATIONS = {
  anonymize:
    "Je confirme l’anonymisation définitive : nom, e-mail, téléphone et note seront effacés et ne pourront pas être restaurés. Le rendez-vous reste dans le calendrier.",
  lift:
    "Je confirme la levée de la limitation : la personne recevra un e-mail d’information et les rappels encore à venir reprendront.",
} as const;

/** One action the detail view may offer for a request. */
export type PrivacyRequestAction = "export" | "rectify" | "anonymize" | "restrict" | "lift";

/**
 * Which actions a request admits *now*, from its type, its status and the
 * current state of its bookings — the same rules the server enforces, so
 * the view never offers a button the server would refuse:
 *
 * - access / portability: export, whatever the status (a closed request may
 *   be exported again; the document is never stored);
 * - rectification, erasure, restriction: their action while the request is
 *   open and at least one linked booking still holds live data;
 * - restriction: lift, whatever the status, while at least one linked
 *   booking is restricted (an anonymised booking is never restricted).
 */
export function availableActions(
  request: Pick<AdminPrivacyRequest, "type" | "status">,
  bookings: readonly AdminPrivacyRequestScopeBooking[],
): PrivacyRequestAction[] {
  const open = request.status !== "closed";
  const live = bookings.some((booking) => booking.customerDataErasedAt === null);
  const restricted = bookings.some(
    (booking) => booking.processingRestrictedAt !== null && booking.customerDataErasedAt === null,
  );
  switch (request.type) {
    case "access":
    case "portability":
      return ["export"];
    case "rectification":
      return open && live ? ["rectify"] : [];
    case "erasure":
      return open && live ? ["anonymize"] : [];
    case "restriction":
      return [...(open && live ? (["restrict"] as const) : []), ...(restricted ? (["lift"] as const) : [])];
  }
}

/** The representation a request type answers with by default; the other stays offered. */
export function defaultExportFormat(type: AdminPrivacyRequestType): "html" | "json" {
  return type === "portability" ? "json" : "html";
}

/**
 * The rectification entries for the bookings that still hold data: each
 * pre-filled with the current values and carrying the booking's own token,
 * so the server's customer-update authority can refuse a stale edit.
 */
export function rectificationEntries(
  bookings: readonly AdminPrivacyRequestScopeBooking[],
): AdminPrivacyRectificationEntry[] {
  return bookings.flatMap((booking) =>
    booking.customer === null
      ? []
      : [
          {
            reference: booking.reference,
            expectedUpdatedAt: booking.updatedAt,
            customerName: booking.customer.name,
            customerEmail: booking.customer.email,
            customerPhone: booking.customer.phone,
            customerNote: booking.customer.note,
          },
        ],
  );
}

/** The MIME type a representation is saved with. */
export function exportMimeType(format: "html" | "json"): string {
  return format === "html" ? "text/html;charset=utf-8" : "application/json;charset=utf-8";
}

/**
 * The bytes a representation is saved as: the HTML page as is, the JSON
 * document pretty-printed. The name comes from the server and holds only
 * the request id.
 */
export function exportFileContents(exported: { format: "html"; document: string } | { format: "json"; document: unknown }): string {
  return exported.format === "html" ? exported.document : JSON.stringify(exported.document, null, 2);
}

/** How an identification input is to be searched, or that it cannot be. */
export type PrivacyIdentification =
  | { kind: "reference"; reference: string }
  | { kind: "email"; email: string }
  | { kind: "invalid" };

const CURRENT_REFERENCE = new RegExp(BOOKING_REFERENCE_CURRENT_PATTERN);
const LEGACY_REFERENCE = new RegExp(BOOKING_REFERENCE_LEGACY_PATTERN);

/**
 * Classifies what the administrator typed. An `@` makes it an e-mail; a
 * legacy `bk_` token is kept as typed (hex is lower-case); anything else is
 * tried as a current reference in upper case, because the customer may have
 * read it aloud or typed it in lower case. There is no fourth outcome: a
 * string that is neither is refused before any request is sent.
 */
export function classifyIdentification(input: string): PrivacyIdentification {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "invalid" };
  if (trimmed.includes("@")) {
    // The server's schema is the authority on what an address is; this is
    // only the cheapest local refusal of an obviously unusable value.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
      ? { kind: "email", email: trimmed }
      : { kind: "invalid" };
  }
  if (trimmed.startsWith("bk_")) {
    return LEGACY_REFERENCE.test(trimmed) ? { kind: "reference", reference: trimmed } : { kind: "invalid" };
  }
  const current = trimmed.toUpperCase();
  return CURRENT_REFERENCE.test(current) ? { kind: "reference", reference: current } : { kind: "invalid" };
}

/**
 * Toggles one reference in the selection, keeping selection order — which
 * is the order the register stores.
 */
export function toggleReference(selected: readonly string[], reference: string): string[] {
  return selected.includes(reference)
    ? selected.filter((candidate) => candidate !== reference)
    : [...selected, reference];
}

/**
 * Whether the reviewed scope may be recorded.
 *
 * A shared e-mail never implies every booking: the matches are a list to
 * choose from, and recording needs either at least one ticked reference or
 * the explicit confirmation that none is concerned. A partial list (the
 * server said more matches exist) is never recordable: the administrator has
 * not reviewed the whole scope yet.
 */
export function scopeIsRecordable(input: {
  selected: readonly string[];
  confirmedEmpty: boolean;
  hasMore: boolean;
}): boolean {
  if (input.hasMore) return false;
  if (input.selected.length > PRIVACY_REQUEST_MAX_BOOKING_REFERENCES) return false;
  return input.selected.length > 0 || input.confirmedEmpty;
}

/** What the scope review says about the completeness of the list. */
export function describeScopeCompleteness(page: { hasMore: boolean }, matchCount: number): string {
  if (page.hasMore) return ADMIN_PRIVACY_MESSAGES.scopePartial;
  if (matchCount === 0) return ADMIN_PRIVACY_MESSAGES.emailNoMatch;
  return ADMIN_PRIVACY_MESSAGES.scopeComplete;
}

/** Appends a further page of matches without duplicating a reference. */
export function mergeMatches(
  current: readonly AdminPrivacyRequestMatch[],
  next: readonly AdminPrivacyRequestMatch[],
): AdminPrivacyRequestMatch[] {
  const known = new Set(current.map((match) => match.reference));
  return [...current, ...next.filter((match) => !known.has(match.reference))];
}

/**
 * The message for a failure of this surface. `not-found` is the one kind the
 * shared client cannot word for us — its message names media — so it is
 * translated here per step; every other kind keeps the contract's message.
 */
export function privacyFailureMessage(
  failure: AdminApiFailure,
  context: "reference" | "record" | "register" | "action",
): string {
  if (failure.kind === "not-found") {
    return context === "register" || context === "action"
      ? ADMIN_PRIVACY_MESSAGES.registerNotFound
      : ADMIN_PRIVACY_MESSAGES.referenceNotFound;
  }
  // ESZ-164: a rectification refused for a stale token is the calendar's
  // own 409, worded for this surface.
  if (context === "action" && failure.kind === "conflict" && failure.errorCode === "REVISION_CONFLICT") {
    return ADMIN_PRIVACY_MESSAGES.staleRectification;
  }
  return failure.message;
}
