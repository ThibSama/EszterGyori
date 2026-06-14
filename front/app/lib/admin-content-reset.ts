import type { DraftDeleteResult } from "./admin-draft-storage";
import type { SiteContent } from "../types/site-content";

export interface CompleteResetState {
  content: SiteContent;
  cleanContent: SiteContent;
  isDirty: false;
  draftSavedAt: null;
  hasInvalidStoredDraft: false;
  errorMessage: null;
  statusMessage: string;
}

export type CompleteResetResult =
  | { ok: true; state: CompleteResetState }
  | { ok: false; errorMessage: string };

export const COMPLETE_RESET_SUCCESS_MESSAGE =
  "Le contenu et le brouillon local ont été réinitialisés à la version d’origine.";

export function cloneSiteContent(content: SiteContent): SiteContent {
  return structuredClone(content);
}

export function createCompleteResetState(
  defaultContent: SiteContent,
  deleteResult: DraftDeleteResult,
): CompleteResetResult {
  if (!deleteResult.ok) {
    return {
      ok: false,
      errorMessage: deleteResult.error.message,
    };
  }

  return {
    ok: true,
    state: {
      content: cloneSiteContent(defaultContent),
      cleanContent: cloneSiteContent(defaultContent),
      isDirty: false,
      draftSavedAt: null,
      hasInvalidStoredDraft: false,
      errorMessage: null,
      statusMessage: COMPLETE_RESET_SUCCESS_MESSAGE,
    },
  };
}
