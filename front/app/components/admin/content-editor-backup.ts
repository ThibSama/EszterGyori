import { useCallback, useRef, useState, type Dispatch, type RefObject } from "react";
import {
  deleteDraft,
  loadDraft,
  MAX_DRAFT_IMPORT_BYTES,
  parseDraft,
  saveDraft,
  serializeDraft,
} from "../../lib/admin-draft-storage";
import type { AdminDraftAction } from "../../lib/admin-server-draft";
import type { EditorLocalDocument } from "./content-editor-controller";
import type { SiteContent } from "../../types/site-content";

/**
 * The editor's local backup / import-export unit (ESZ-107).
 *
 * This unit owns everything the device and the filesystem are for the editor:
 * the explicit device backup, its restoration and deletion, and the JSON
 * export/import pair. The storage primitives themselves (`saveDraft`,
 * `loadDraft`, `parseDraft`, …) live in `lib/admin-draft-storage`; what this
 * module adds is the state the header shows (`backupSavedAt`,
 * `hasInvalidStoredBackup`), the file input the import flows reset, and the
 * confirmation/message copy that turns a device read into an admin decision.
 *
 * ## Never authoritative
 *
 * Nothing here is automatic on load and nothing here is the source of truth:
 * this is the "explicit backup / export-recovery" role `localStorage` keeps.
 * The bootstrap only *reports* that a backup exists (via `refreshStatus`, after
 * the server draft has loaded); the only way a backup reaches the editor is
 * the explicit restore button, and the only way it reaches the server is the
 * ordinary save button afterwards. The server flows of the controller call
 * `writeLocalBackup` on the paths that are about to replace or lose what is on
 * screen — a 401, a server reload, a 409, a reset — so unsaved work always has
 * somewhere to survive; they pass the working document explicitly, because the
 * document belongs to the controller.
 *
 * ## The one cross-module seam
 *
 * Restore and import replace the working document. That document is the
 * controller's, so the two handlers receive it per call as an
 * {@link EditorLocalDocument} handle instead of owning a second copy of it.
 */

export const BACKUP_MESSAGES = {
  restoreBackupConfirm:
    "Remplacer le contenu affiché dans l’éditeur par la sauvegarde locale de cet appareil ? Le brouillon du serveur ne sera pas modifié tant que vous n’enregistrez pas.",
  deleteBackupConfirm:
    "Supprimer la sauvegarde locale de cet appareil ? Le brouillon du serveur et le site public resteront inchangés.",
  importConfirm:
    "Importer ce fichier remplacera le contenu actuellement affiché dans l'éditeur. Le brouillon du serveur ne sera pas modifié tant que vous n’enregistrez pas. Continuer ?",
  backupSaved:
    "Sauvegarde locale écrite sur cet appareil. Elle sert uniquement de secours : le brouillon du serveur fait foi.",
  backupRestored:
    "Sauvegarde locale chargée dans l’éditeur. Enregistrez sur le serveur pour la conserver.",
  backupDeleted:
    "Sauvegarde locale supprimée de cet appareil. Le brouillon du serveur reste inchangé.",
  backupMissing: "Aucune sauvegarde locale n’est enregistrée sur cet appareil.",
  exported:
    "Sauvegarde JSON exportée avec le contenu actuellement affiché, y compris les modifications non enregistrées.",
  imported:
    "Fichier JSON importé dans l’éditeur. Enregistrez-le sur le serveur pour le conserver.",
  importCancelled: "Import JSON annulé. Le contenu actuel est conservé.",
} as const;

function getDraftFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `eszter-content-draft-${year}-${month}-${day}-${hours}${minutes}.json`;
}

export interface ContentEditorBackup {
  /** When the device backup was last written; `null` when none is known. */
  backupSavedAt: string | null;
  /** A backup exists on the device but failed to parse; the admin can delete it. */
  hasInvalidStoredBackup: boolean;
  /** The hidden file input the import flows reset after every attempt. */
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** Writes the working document to the device; false when it could not write. */
  writeLocalBackup(content: SiteContent): boolean;
  /** Re-reads the device so the header reports whether a backup exists. */
  refreshStatus(): void;
  handleSaveLocalBackup(document: EditorLocalDocument): void;
  handleRestoreLocalBackup(document: EditorLocalDocument): void;
  handleDeleteLocalBackup(): void;
  handleExportDraft(document: EditorLocalDocument): void;
  handleImportDraft(
    file: File | undefined,
    document: EditorLocalDocument,
  ): Promise<void>;
}

export function useContentEditorBackup({
  dispatch,
}: {
  dispatch: Dispatch<AdminDraftAction>;
}): ContentEditorBackup {
  const [backupSavedAt, setBackupSavedAt] = useState<string | null>(null);
  const [hasInvalidStoredBackup, setHasInvalidStoredBackup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Writes the editor's current content to the device as a backup.
   *
   * Never automatic on load and never authoritative: this is the "explicit
   * backup / export-recovery" role `localStorage` keeps, and nothing reads it
   * back without the admin asking. The controller calls it on the paths that
   * are about to replace what is on screen — a 401, a 409, a server reload, a
   * reset — so an unsaved edit always has somewhere to survive.
   */
  const writeLocalBackup = useCallback(
    (content: SiteContent): boolean => {
      const result = saveDraft(content);
      if (!result.ok) {
        dispatch({ type: "local-error", errorMessage: result.error.message });
        return false;
      }
      setBackupSavedAt(result.draft.savedAt);
      setHasInvalidStoredBackup(false);
      return true;
    },
    [dispatch],
  );

  /**
   * Re-reads the device so the header can report that a backup exists.
   *
   * Called by the controller's bootstrap effect after the server draft has
   * loaded. Whether a backup exists is *reported*, never applied: this is what
   * lets the header say "a backup from 14:32 exists" without that backup ever
   * becoming the content anyone is editing.
   */
  const refreshStatus = useCallback(() => {
    const backup = loadDraft();
    setBackupSavedAt(backup.ok ? (backup.draft?.savedAt ?? null) : null);
    setHasInvalidStoredBackup(backup.ok ? false : backup.canDelete);
  }, []);

  function handleSaveLocalBackup(document: EditorLocalDocument) {
    if (writeLocalBackup(document.read())) {
      dispatch({
        type: "local-message",
        statusMessage: BACKUP_MESSAGES.backupSaved,
      });
    }
  }

  function handleRestoreLocalBackup(document: EditorLocalDocument) {
    const result = loadDraft();

    if (!result.ok) {
      setHasInvalidStoredBackup(result.canDelete);
      dispatch({ type: "local-error", errorMessage: result.error.message });
      return;
    }

    if (!result.draft) {
      dispatch({ type: "local-error", errorMessage: BACKUP_MESSAGES.backupMissing });
      return;
    }

    if (!window.confirm(BACKUP_MESSAGES.restoreBackupConfirm)) return;

    // Restoring content identical to what the server already holds is not an
    // edit, and marking it dirty would put a "unsaved changes" warning on a
    // document that matches the draft byte for byte.
    document.replace(result.draft.content, document.differsFromBase(result.draft.content));
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({
      type: "local-message",
      statusMessage: BACKUP_MESSAGES.backupRestored,
    });
  }

  function handleDeleteLocalBackup() {
    if (!window.confirm(BACKUP_MESSAGES.deleteBackupConfirm)) return;

    const result = deleteDraft();

    if (!result.ok) {
      dispatch({ type: "local-error", errorMessage: result.error.message });
      return;
    }

    setBackupSavedAt(null);
    setHasInvalidStoredBackup(false);
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({
      type: "local-message",
      statusMessage: BACKUP_MESSAGES.backupDeleted,
    });
  }

  function handleExportDraft(editorDocument: EditorLocalDocument) {
    const json = serializeDraft(editorDocument.read());
    const parsed = parseDraft(json);

    if (!parsed.ok) {
      dispatch({ type: "local-error", errorMessage: parsed.error.message });
      return;
    }

    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = getDraftFileName(new Date(parsed.draft.savedAt));
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({ type: "local-message", statusMessage: BACKUP_MESSAGES.exported });
  }

  async function handleImportDraft(
    file: File | undefined,
    document: EditorLocalDocument,
  ) {
    try {
      if (!file) return;

      const isJsonFile =
        file.name.toLowerCase().endsWith(".json") ||
        file.type === "application/json";

      if (!isJsonFile) {
        dispatch({
          type: "local-error",
          errorMessage: "Seuls les fichiers JSON sont acceptés.",
        });
        return;
      }

      if (file.size > MAX_DRAFT_IMPORT_BYTES) {
        dispatch({
          type: "local-error",
          errorMessage: "Le fichier dépasse la limite autorisée de 1 Mo.",
        });
        return;
      }

      const text = await file.text();
      const parsed = parseDraft(text);

      if (!parsed.ok) {
        dispatch({ type: "local-error", errorMessage: parsed.error.message });
        return;
      }

      if (!window.confirm(BACKUP_MESSAGES.importConfirm)) {
        dispatch({ type: "local-error", errorMessage: null });
        dispatch({
          type: "local-message",
          statusMessage: BACKUP_MESSAGES.importCancelled,
        });
        return;
      }

      document.replace(parsed.draft.content, true);
      dispatch({ type: "local-error", errorMessage: null });
      dispatch({ type: "local-message", statusMessage: BACKUP_MESSAGES.imported });
    } catch {
      dispatch({
        type: "local-error",
        errorMessage: "Impossible de lire ce fichier JSON dans le navigateur.",
      });
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return {
    backupSavedAt,
    hasInvalidStoredBackup,
    fileInputRef,
    writeLocalBackup,
    refreshStatus,
    handleSaveLocalBackup,
    handleRestoreLocalBackup,
    handleDeleteLocalBackup,
    handleExportDraft,
    handleImportDraft,
  };
}
