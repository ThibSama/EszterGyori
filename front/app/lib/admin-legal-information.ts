import {
  LEGAL_REGISTERS_MAX,
  legalInformationSchema,
  legalInformationWarnings,
  type LegalInformation,
  type LegalWarning,
} from "@eszter/contracts";
import type { AdminApiFailure } from "./admin-api";

/**
 * ESZ-165 — the pure half of `Paramètres > Informations juridiques`.
 *
 * The form edits a flat draft of strings and two applicability switches;
 * this module turns the stored document into that draft and the draft back
 * into a document the contract accepts. The rules are the contract's own:
 * an empty field is `null` (unknown, never an empty string), a switched-off
 * applicability drops its value, and the schema decides what is well-formed.
 * Warnings are `legalInformationWarnings` — the same function the tests
 * pin — so the page shows exactly what the application considers missing.
 */

export interface LegalRegisterDraft {
  readonly label: string;
  readonly reference: string;
}

export interface LegalDraft {
  readonly legalName: string;
  readonly tradeName: string;
  readonly legalForm: string;
  readonly siren: string;
  readonly siret: string;
  readonly registers: readonly LegalRegisterDraft[];
  readonly vatApplicable: boolean;
  readonly vatNumber: string;
  readonly activity: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly hostingName: string;
  readonly hostingAddress: string;
  readonly hostingPhone: string;
  readonly hostingWebsite: string;
  readonly registeredAddress: string;
  readonly salonAddressApplicable: boolean;
  readonly salonAddress: string;
}

export type LegalDraftField = Exclude<keyof LegalDraft, "registers" | "vatApplicable" | "salonAddressApplicable">;

/** Field-level refusals, keyed by draft field; registers by `registers.<index>`. */
export type LegalDraftErrors = Partial<Record<LegalDraftField | `registers.${number}`, string>>;

export const ADMIN_LEGAL_MESSAGES = {
  loading: "Chargement des informations juridiques…",
  saved: "Les informations juridiques ont été enregistrées. Les pages publiques sont à jour.",
  conflict:
    "Les informations ont été modifiées entre-temps. Elles ont été rechargées : vérifiez puis enregistrez de nouveau.",
  validation: "Certaines valeurs ont été refusées par le serveur. Vérifiez le formulaire avant de réessayer.",
  forbidden: "La requête a été refusée pour raison de sécurité. Réessayez.",
  complete: "Toutes les informations requises sont renseignées.",
  incomplete:
    "Les informations manquantes ci-dessous ne sont pas affichées sur les pages publiques ; seules les valeurs renseignées y apparaissent.",
} as const;

export const LEGAL_DRAFT_ERRORS = {
  siren: "Le SIREN doit comporter exactement 9 chiffres.",
  siret: "Le SIRET doit comporter exactement 14 chiffres.",
  vatNumber: "Le numéro de TVA doit commencer par deux lettres (ex. FR) suivies de 2 à 13 caractères.",
  contactEmail: "L’adresse e-mail n’est pas valide.",
  hostingWebsite: "L’adresse du site doit commencer par http:// ou https://.",
  tooLong: "Cette valeur est trop longue.",
  register: "Un registre doit avoir un nom et une référence.",
} as const;

function text(value: string | null): string {
  return value ?? "";
}

/** `null` for an empty or whitespace-only field: unknown is unset, never "". */
function valueOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function draftFromInformation(information: LegalInformation): LegalDraft {
  return {
    legalName: text(information.legalName),
    tradeName: text(information.tradeName),
    legalForm: text(information.legalForm),
    siren: text(information.siren),
    siret: text(information.siret),
    registers: information.registers.map((register) => ({ ...register })),
    vatApplicable: information.vat.applicable,
    vatNumber: information.vat.applicable ? text(information.vat.number) : "",
    activity: text(information.activity),
    contactEmail: text(information.contact.email),
    contactPhone: text(information.contact.phone),
    hostingName: text(information.hosting.name),
    hostingAddress: text(information.hosting.address),
    hostingPhone: text(information.hosting.phone),
    hostingWebsite: text(information.hosting.website),
    registeredAddress: text(information.registeredAddress),
    salonAddressApplicable: information.salonAddress.applicable,
    salonAddress: information.salonAddress.applicable ? text(information.salonAddress.address) : "",
  };
}

/**
 * The document the draft describes, unvalidated. Registers with both fields
 * empty are dropped (an empty row is "no register", not an error); a
 * half-filled one is kept so the schema can refuse it by index.
 */
function candidateFromDraft(draft: LegalDraft): unknown {
  return {
    legalName: valueOrNull(draft.legalName),
    tradeName: valueOrNull(draft.tradeName),
    legalForm: valueOrNull(draft.legalForm),
    siren: valueOrNull(draft.siren),
    siret: valueOrNull(draft.siret),
    registers: draft.registers
      .filter((register) => register.label.trim() !== "" || register.reference.trim() !== "")
      .map((register) => ({ label: register.label.trim(), reference: register.reference.trim() })),
    vat: draft.vatApplicable
      ? { applicable: true, number: valueOrNull(draft.vatNumber)?.toUpperCase().replace(/\s+/g, "") ?? null }
      : { applicable: false },
    activity: valueOrNull(draft.activity),
    contact: { email: valueOrNull(draft.contactEmail), phone: valueOrNull(draft.contactPhone) },
    hosting: {
      name: valueOrNull(draft.hostingName),
      address: valueOrNull(draft.hostingAddress),
      phone: valueOrNull(draft.hostingPhone),
      website: valueOrNull(draft.hostingWebsite),
    },
    registeredAddress: valueOrNull(draft.registeredAddress),
    salonAddress: draft.salonAddressApplicable
      ? { applicable: true, address: valueOrNull(draft.salonAddress) }
      : { applicable: false },
  };
}

/** Where a schema issue lands in the draft, so the refusal sits next to its field. */
function draftFieldOf(path: PropertyKey[]): keyof LegalDraftErrors | null {
  const [head, second] = path;
  switch (head) {
    case "legalName":
    case "tradeName":
    case "legalForm":
    case "siren":
    case "siret":
    case "activity":
    case "registeredAddress":
      return head;
    case "vat":
      return "vatNumber";
    case "contact":
      return second === "email" ? "contactEmail" : "contactPhone";
    case "hosting":
      return second === "name"
        ? "hostingName"
        : second === "address"
          ? "hostingAddress"
          : second === "phone"
            ? "hostingPhone"
            : "hostingWebsite";
    case "salonAddress":
      return "salonAddress";
    case "registers":
      return typeof second === "number" ? `registers.${second}` : null;
    default:
      return null;
  }
}

function messageFor(field: keyof LegalDraftErrors): string {
  if (field === "siren") return LEGAL_DRAFT_ERRORS.siren;
  if (field === "siret") return LEGAL_DRAFT_ERRORS.siret;
  if (field === "vatNumber") return LEGAL_DRAFT_ERRORS.vatNumber;
  if (field === "contactEmail") return LEGAL_DRAFT_ERRORS.contactEmail;
  if (field === "hostingWebsite") return LEGAL_DRAFT_ERRORS.hostingWebsite;
  if (field.startsWith("registers.")) return LEGAL_DRAFT_ERRORS.register;
  // Every other text field has one structural bound left to break: its length.
  return LEGAL_DRAFT_ERRORS.tooLong;
}

/**
 * Validates the draft against the contract and returns the document to
 * send, or the field errors that stop it. Partial documents are valid: a
 * missing fact is a warning, not an error.
 */
export function informationFromDraft(
  draft: LegalDraft,
): { ok: true; information: LegalInformation } | { ok: false; errors: LegalDraftErrors } {
  const parsed = legalInformationSchema.safeParse(candidateFromDraft(draft));
  if (parsed.success) return { ok: true, information: parsed.data };
  const errors: LegalDraftErrors = {};
  for (const issue of parsed.error.issues) {
    const field = draftFieldOf(issue.path);
    if (field !== null && errors[field] === undefined) errors[field] = messageFor(field);
  }
  return { ok: false, errors };
}

/** The warnings the draft would carry if saved as it stands — live, as the admin types. */
export function draftWarnings(draft: LegalDraft): LegalWarning[] {
  const result = informationFromDraft(draft);
  return result.ok ? legalInformationWarnings(result.information) : [];
}

export function canAddRegister(draft: LegalDraft): boolean {
  return draft.registers.length < LEGAL_REGISTERS_MAX;
}

export function legalFailureMessage(failure: AdminApiFailure): string {
  switch (failure.kind) {
    case "conflict":
      return ADMIN_LEGAL_MESSAGES.conflict;
    case "validation":
      return ADMIN_LEGAL_MESSAGES.validation;
    case "forbidden":
      return ADMIN_LEGAL_MESSAGES.forbidden;
    default:
      return failure.message;
  }
}
