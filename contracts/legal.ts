import { z } from "zod";
import { BOOKING_PRIVACY_POLICY_PATH } from "./booking.js";

/**
 * ESZ-165 — the administrable legal information and the two public pages it
 * publishes.
 *
 * ## One persisted source
 *
 * The facts a French business must publish about itself — who it is, where
 * it is registered, how to reach it, who hosts the site — live in exactly one
 * place: a `system_settings` row the PHP backend owns
 * ({@link LEGAL_INFORMATION_SETTING_KEY}). The admin edits that row through
 * `/api/admin/settings/legal`; `/mentions-legales` and
 * `/confidentialite` read it through `/api/legal`. Nothing here is copied into
 * `SiteContent`, a frontend constant or a page-specific object: the ESZ-161
 * booking notice only ever named the trade name and the contact address the
 * public site already publishes, and it keeps naming them as it was issued.
 *
 * ## Unknown is unset, never invented
 *
 * Esther's production identifiers (SIREN, SIRET, registers, VAT number,
 * addresses, host) are not known to this repository, and this module refuses
 * to guess them: {@link emptyLegalInformation} is all-`null`, every field
 * accepts `null`, and the storage accepts a partially filled document. What
 * is missing is reported by {@link legalInformationWarnings} — to the
 * administrator, and to nobody else.
 *
 * ## Applicability is a value, not an empty string
 *
 * Some facts may legitimately not apply: a business under the VAT franchise
 * has no VAT number; a practitioner with no separate salon has no second
 * address; a trade name is optional. Where the law or the business allows
 * "does not apply", the model says so explicitly with a discriminated
 * `applicable` flag, and the public projection ({@link publicLegalFacts})
 * drops a non-applicable fact entirely — no label, no placeholder, no `N/A`.
 * A fact that merely has not been filled in yet is `null` and is dropped from
 * the public page too, because a visitor is never shown a configuration gap.
 */

/** The `system_settings` key the backend stores the document under. */
export const LEGAL_INFORMATION_SETTING_KEY = "legal.information";

/** Public page: the legal notice (mentions légales). */
export const LEGAL_NOTICE_PATH = "/mentions-legales";

/**
 * Public page: the privacy policy. ESZ-161 froze this path in the booking
 * privacy notice, and ESZ-165 makes it real; re-exported so a page and a
 * footer link resolve it from the same constant the notice does.
 */
export const PRIVACY_POLICY_PATH = BOOKING_PRIVACY_POLICY_PATH;

/** The footer's two legal destinations, in display order. Fixed, not editable. */
export const LEGAL_PAGE_LINKS = [
  { id: "legal-notice", label: "Mentions légales", href: LEGAL_NOTICE_PATH },
  { id: "privacy-policy", label: "Politique de confidentialité", href: PRIVACY_POLICY_PATH },
] as const;

export const LEGAL_TEXT_MAX_LENGTH = 200;
export const LEGAL_MULTILINE_MAX_LENGTH = 600;
export const LEGAL_REGISTERS_MAX = 6;

/** SIREN: nine digits. Structural only; the value is never looked up. */
export const SIREN_PATTERN = "^[0-9]{9}$";
/** SIRET: fourteen digits (the SIREN followed by the five-digit NIC). */
export const SIRET_PATTERN = "^[0-9]{14}$";
/**
 * An intra-community VAT number: a two-letter country code followed by 2 to
 * 13 alphanumerics (FR + key + SIREN is the French case). Structural only.
 */
export const VAT_NUMBER_PATTERN = "^[A-Z]{2}[A-Z0-9]{2,13}$";
/** A web address: http(s) only, no whitespace. The same rule on both sides of the wire. */
export const WEB_URL_PATTERN = "^https?://[^\\s]+$";

const trimmedText = z.string().trim().min(1).max(LEGAL_TEXT_MAX_LENGTH);
const trimmedMultiline = z.string().trim().min(1).max(LEGAL_MULTILINE_MAX_LENGTH);

/** A short fact: set, or genuinely unknown. */
export const legalTextSchema = trimmedText.nullable();
/** A postal address as lines, or genuinely unknown. */
export const legalMultilineSchema = trimmedMultiline.nullable();

export const sirenSchema = z.string().regex(new RegExp(SIREN_PATTERN)).nullable();
export const siretSchema = z.string().regex(new RegExp(SIRET_PATTERN)).nullable();
export const vatNumberSchema = z.string().regex(new RegExp(VAT_NUMBER_PATTERN)).nullable();
export const legalEmailSchema = z.email().max(LEGAL_TEXT_MAX_LENGTH).nullable();
export const legalUrlSchema = z
  .string()
  .regex(new RegExp(WEB_URL_PATTERN))
  .max(LEGAL_TEXT_MAX_LENGTH)
  .nullable();

/** One registration: the register it is in and the reference it carries there. */
export const legalRegisterSchema = z
  .object({
    /** e.g. "RCS Lille Métropole", "Registre national des entreprises". */
    label: trimmedText,
    /** The reference as the register issues it. */
    reference: trimmedText,
  })
  .strict();

/**
 * VAT, with its applicability. `applicable: false` is the VAT franchise (a
 * business that charges no VAT has no number to publish); `applicable: true`
 * with a `null` number is "applies, not filled in yet" — an admin warning.
 */
export const legalVatSchema = z.discriminatedUnion("applicable", [
  z.object({ applicable: z.literal(true), number: vatNumberSchema }).strict(),
  z.object({ applicable: z.literal(false) }).strict(),
]);

/**
 * The salon's own address, separate from the registered one. `applicable:
 * false` means there is no distinct business location to publish (the salon
 * is at the registered address, or the practitioner has none).
 */
export const legalSalonAddressSchema = z.discriminatedUnion("applicable", [
  z.object({ applicable: z.literal(true), address: legalMultilineSchema }).strict(),
  z.object({ applicable: z.literal(false) }).strict(),
]);

export const legalContactSchema = z
  .object({
    email: legalEmailSchema,
    phone: legalTextSchema,
  })
  .strict();

export const legalHostingSchema = z
  .object({
    /** The hosting provider's name. */
    name: legalTextSchema,
    /** The provider's postal address. */
    address: legalMultilineSchema,
    phone: legalTextSchema,
    website: legalUrlSchema,
  })
  .strict();

/** The persisted document. Every fact is nullable; nothing is defaulted to a guess. */
export const legalInformationSchema = z
  .object({
    /** The legal identity: the company name, or the individual's name for a sole trader. */
    legalName: legalTextSchema,
    /** The trade name (nom commercial), if one exists. */
    tradeName: legalTextSchema,
    /** The legal form (entrepreneur individuel, SASU, EURL…). */
    legalForm: legalTextSchema,
    siren: sirenSchema,
    siret: siretSchema,
    /** The registers the business is recorded in; empty when none is known or applies. */
    registers: z.array(legalRegisterSchema).max(LEGAL_REGISTERS_MAX),
    vat: legalVatSchema,
    /** The activity as declared (e.g. "Maquillage permanent"). */
    activity: legalTextSchema,
    contact: legalContactSchema,
    hosting: legalHostingSchema,
    /** The registered (legal) address. */
    registeredAddress: legalMultilineSchema,
    salonAddress: legalSalonAddressSchema,
  })
  .strict();

export type LegalInformation = z.infer<typeof legalInformationSchema>;
export type LegalRegister = z.infer<typeof legalRegisterSchema>;

/**
 * The document a deployment starts with: nothing known. VAT and the salon
 * address start as *applicable and unknown* rather than as "does not apply",
 * because deciding that a fact does not apply is the administrator's call,
 * and defaulting it would silently make it for them.
 */
export function emptyLegalInformation(): LegalInformation {
  return {
    legalName: null,
    tradeName: null,
    legalForm: null,
    siren: null,
    siret: null,
    registers: [],
    vat: { applicable: true, number: null },
    activity: null,
    contact: { email: null, phone: null },
    hosting: { name: null, address: null, phone: null, website: null },
    registeredAddress: null,
    salonAddress: { applicable: true, address: null },
  };
}

/** Where a missing required fact lives, for the admin form to point at. */
export const legalWarningFields = [
  "legalName",
  "legalForm",
  "siren",
  "siret",
  "vat.number",
  "activity",
  "contact.email",
  "hosting.name",
  "hosting.address",
  "registeredAddress",
  "salonAddress.address",
] as const;

export type LegalWarningField = (typeof legalWarningFields)[number];

export interface LegalWarning {
  readonly field: LegalWarningField;
  readonly message: string;
}

/** The admin-facing message for each required fact that is unset. */
export const LEGAL_WARNING_MESSAGES: Record<LegalWarningField, string> = {
  legalName: "La dénomination ou le nom de l’exploitant n’est pas renseigné.",
  legalForm: "La forme juridique n’est pas renseignée.",
  siren: "Le numéro SIREN n’est pas renseigné.",
  siret: "Le numéro SIRET n’est pas renseigné.",
  "vat.number":
    "Le numéro de TVA intracommunautaire n’est pas renseigné. Indiquez-le, ou précisez que la TVA n’est pas applicable.",
  activity: "L’activité n’est pas renseignée.",
  "contact.email": "L’adresse e-mail de contact n’est pas renseignée.",
  "hosting.name": "Le nom de l’hébergeur n’est pas renseigné.",
  "hosting.address": "L’adresse de l’hébergeur n’est pas renseignée.",
  registeredAddress: "L’adresse légale (siège) n’est pas renseignée.",
  "salonAddress.address":
    "L’adresse du salon n’est pas renseignée. Indiquez-la, ou précisez qu’il n’y a pas d’adresse distincte.",
};

/**
 * The required facts that are still unset, in form order.
 *
 * "Required" is what the application considers necessary for the legal
 * notice to be complete, not a legal opinion: the identity, the registration
 * numbers, the activity, a contact address, the host and the legal address.
 * A fact marked as not applicable is complete by that very statement and
 * never warns. These warnings are for the admin surface only: the public
 * projection below never carries them.
 */
export function legalInformationWarnings(information: LegalInformation): LegalWarning[] {
  const missing: LegalWarningField[] = [];
  if (information.legalName === null) missing.push("legalName");
  if (information.legalForm === null) missing.push("legalForm");
  if (information.siren === null) missing.push("siren");
  if (information.siret === null) missing.push("siret");
  if (information.vat.applicable && information.vat.number === null) missing.push("vat.number");
  if (information.activity === null) missing.push("activity");
  if (information.contact.email === null) missing.push("contact.email");
  if (information.hosting.name === null) missing.push("hosting.name");
  if (information.hosting.address === null) missing.push("hosting.address");
  if (information.registeredAddress === null) missing.push("registeredAddress");
  if (information.salonAddress.applicable && information.salonAddress.address === null) {
    missing.push("salonAddress.address");
  }
  return missing.map((field) => ({ field, message: LEGAL_WARNING_MESSAGES[field] }));
}

/** One published line: its label and its value, with `multiline` for addresses. */
export interface LegalFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly multiline?: true;
  readonly href?: string;
}

/** One titled group of the public legal notice. Only groups with at least one fact are returned. */
export interface LegalFactGroup {
  readonly key: "identity" | "registration" | "contact" | "hosting";
  readonly title: string;
  readonly facts: readonly LegalFact[];
}

function fact(key: string, label: string, value: string | null, extra?: Partial<LegalFact>): LegalFact[] {
  return value === null ? [] : [{ key, label, value, ...extra }];
}

/**
 * The public projection of the stored document: exactly the facts that are
 * set and applicable, grouped as the legal notice renders them.
 *
 * This is the single hiding rule. A `null` fact, a non-applicable VAT, a
 * non-applicable salon address and an empty register list all disappear —
 * there is no label without a value anywhere in the result, so a page that
 * renders this cannot show a placeholder even by accident.
 */
export function publicLegalFacts(information: LegalInformation): LegalFactGroup[] {
  const groups: LegalFactGroup[] = [
    {
      key: "identity",
      title: "Éditeur du site",
      facts: [
        ...fact("legalName", "Dénomination", information.legalName),
        ...fact("tradeName", "Nom commercial", information.tradeName),
        ...fact("legalForm", "Forme juridique", information.legalForm),
        ...fact("activity", "Activité", information.activity),
        ...fact("registeredAddress", "Adresse du siège", information.registeredAddress, {
          multiline: true,
        }),
        ...(information.salonAddress.applicable
          ? fact("salonAddress", "Adresse du salon", information.salonAddress.address, {
              multiline: true,
            })
          : []),
      ],
    },
    {
      key: "registration",
      title: "Immatriculation",
      facts: [
        ...fact("siren", "SIREN", information.siren),
        ...fact("siret", "SIRET", information.siret),
        ...information.registers.map((register, index) => ({
          key: `register-${index}`,
          label: register.label,
          value: register.reference,
        })),
        ...(information.vat.applicable
          ? fact("vat", "TVA intracommunautaire", information.vat.number)
          : []),
      ],
    },
    {
      key: "contact",
      title: "Contact",
      facts: [
        ...fact("email", "E-mail", information.contact.email, {
          href: information.contact.email === null ? undefined : `mailto:${information.contact.email}`,
        }),
        ...fact("phone", "Téléphone", information.contact.phone),
      ],
    },
    {
      key: "hosting",
      title: "Hébergement",
      facts: [
        ...fact("hostingName", "Hébergeur", information.hosting.name),
        ...fact("hostingAddress", "Adresse", information.hosting.address, { multiline: true }),
        ...fact("hostingPhone", "Téléphone", information.hosting.phone),
        ...fact("hostingWebsite", "Site", information.hosting.website, {
          href: information.hosting.website ?? undefined,
        }),
      ],
    },
  ];
  return groups.filter((group) => group.facts.length > 0);
}

/**
 * The controller as the privacy policy names them: the legal name when it is
 * known, else the trade name, else nothing — never a placeholder.
 */
export function legalControllerName(information: LegalInformation): string | null {
  return information.legalName ?? information.tradeName;
}
