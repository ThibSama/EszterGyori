import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  siteContentDraftV1Schema,
  siteContentSchema,
  type SiteContent,
  type SiteContentDraftV1,
} from "@eszter/contracts";
import type { ZodIssue } from "zod";

export const SITE_CONTENT_DRAFT_STORAGE_KEY = "eszter:admin-content-draft:v1";
export const SITE_CONTENT_DRAFT_SCHEMA_VERSION =
  CONTENT_ENVELOPE_SCHEMA_VERSION;
export const MAX_DRAFT_IMPORT_BYTES = 1024 * 1024;

export type { SiteContentDraftV1 };

export type DraftErrorCode =
  | "storage-unavailable"
  | "storage-read-failed"
  | "storage-write-failed"
  | "storage-delete-failed"
  | "empty"
  | "malformed-json"
  | "invalid-schema"
  | "unsupported-version"
  | "invalid-content"
  | "file-too-large";

export interface DraftError {
  code: DraftErrorCode;
  message: string;
}

export type DraftLoadResult =
  | { ok: true; draft: SiteContentDraftV1 | null }
  | { ok: false; error: DraftError; canDelete: boolean };

export type DraftParseResult =
  | { ok: true; draft: SiteContentDraftV1 }
  | { ok: false; error: DraftError };

export type DraftWriteResult =
  | { ok: true; draft: SiteContentDraftV1 }
  | { ok: false; error: DraftError };

export type DraftDeleteResult =
  | { ok: true }
  | { ok: false; error: DraftError };

function error(code: DraftErrorCode, message: string): DraftError {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPath(issue: ZodIssue): string {
  if (issue.path.length === 0) return "racine";
  return issue.path
    .map((part) => (typeof part === "number" ? `[${part}]` : part))
    .join(".")
    .replaceAll(".[", "[");
}

function formatIssue(issue: ZodIssue): string {
  const path = formatPath(issue);

  switch (issue.code) {
    case "invalid_type":
      return `${path} contient un type invalide.`;
    case "invalid_value":
      return `${path} contient une valeur non supportée.`;
    case "unrecognized_keys":
      return `${path} contient un champ non supporté.`;
    case "too_big":
      return `${path} contient trop d'éléments.`;
    case "too_small":
      return `${path} ne contient pas assez d'éléments.`;
    default:
      return `${path} est invalide : ${issue.message}`;
  }
}

function getFirstValidationMessage(issues: ZodIssue[]): string {
  return issues[0] ? formatIssue(issues[0]) : "Le contenu est invalide.";
}

export function validateSiteContent(candidate: unknown): candidate is SiteContent {
  return siteContentSchema.safeParse(candidate).success;
}

export function getSiteContentValidationError(candidate: unknown): string | null {
  const result = siteContentSchema.safeParse(candidate);
  return result.success ? null : getFirstValidationMessage(result.error.issues);
}

export function createDraft(
  content: SiteContent,
  savedAt = new Date().toISOString(),
): SiteContentDraftV1 {
  return {
    schemaVersion: SITE_CONTENT_DRAFT_SCHEMA_VERSION,
    savedAt,
    content,
  };
}

export function serializeDraft(content: SiteContent): string {
  return JSON.stringify(createDraft(content), null, 2);
}

export function parseDraft(input: string): DraftParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    return {
      ok: false,
      error: error("malformed-json", "Le fichier JSON est illisible."),
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: error("invalid-schema", "Le brouillon doit être un objet JSON."),
    };
  }

  if (!Object.hasOwn(parsed, "schemaVersion")) {
    return {
      ok: false,
      error: error("invalid-schema", "Le champ schemaVersion est manquant."),
    };
  }

  if (parsed.schemaVersion !== SITE_CONTENT_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: error(
        "unsupported-version",
        "Cette version de brouillon n'est pas supportée.",
      ),
    };
  }

  const result = siteContentDraftV1Schema.safeParse(parsed);

  if (!result.success) {
    return {
      ok: false,
      error: error("invalid-content", getFirstValidationMessage(result.error.issues)),
    };
  }

  return { ok: true, draft: result.data };
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(): DraftLoadResult {
  const storage = getStorage();
  if (!storage) {
    return {
      ok: false,
      canDelete: false,
      error: error("storage-unavailable", "Le stockage local est indisponible."),
    };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(SITE_CONTENT_DRAFT_STORAGE_KEY);
  } catch {
    return {
      ok: false,
      canDelete: false,
      error: error("storage-read-failed", "Impossible de lire le brouillon local."),
    };
  }

  if (raw === null) {
    return { ok: true, draft: null };
  }

  const parsed = parseDraft(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, canDelete: true };
  }

  return { ok: true, draft: parsed.draft };
}

export function saveDraft(content: SiteContent): DraftWriteResult {
  const contentResult = siteContentSchema.safeParse(content);
  if (!contentResult.success) {
    return {
      ok: false,
      error: error(
        "invalid-content",
        getFirstValidationMessage(contentResult.error.issues),
      ),
    };
  }

  const storage = getStorage();
  if (!storage) {
    return {
      ok: false,
      error: error("storage-unavailable", "Le stockage local est indisponible."),
    };
  }

  const draft = createDraft(contentResult.data);
  try {
    storage.setItem(SITE_CONTENT_DRAFT_STORAGE_KEY, JSON.stringify(draft, null, 2));
  } catch {
    return {
      ok: false,
      error: error(
        "storage-write-failed",
        "Impossible d'enregistrer le brouillon local. Le stockage du navigateur est peut-être plein ou bloqué.",
      ),
    };
  }

  return { ok: true, draft };
}

export function deleteDraft(): DraftDeleteResult {
  const storage = getStorage();
  if (!storage) {
    return {
      ok: false,
      error: error("storage-unavailable", "Le stockage local est indisponible."),
    };
  }

  try {
    storage.removeItem(SITE_CONTENT_DRAFT_STORAGE_KEY);
  } catch {
    return {
      ok: false,
      error: error("storage-delete-failed", "Impossible de supprimer le brouillon local."),
    };
  }

  return { ok: true };
}
