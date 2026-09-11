import {
  BOOKING_REFERENCE_CURRENT_PATTERN,
  BOOKING_REFERENCE_LEGACY_PATTERN,
  PRIVACY_REQUEST_MAX_BOOKING_REFERENCES,
  privacyRequestTypes,
} from "@eszter/contracts";
import type {
  AdminApiFailure,
  AdminPrivacyRequestMatch,
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
} as const;

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
  context: "reference" | "record" | "register",
): string {
  if (failure.kind === "not-found") {
    return context === "register"
      ? ADMIN_PRIVACY_MESSAGES.registerNotFound
      : ADMIN_PRIVACY_MESSAGES.referenceNotFound;
  }
  return failure.message;
}
