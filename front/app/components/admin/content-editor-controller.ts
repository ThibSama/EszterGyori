import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { useAdminSession } from "./admin-session-provider";
import { cloneSiteContent } from "../../lib/site-content-clone";
import {
  canWrite,
  type AdminDraftAction,
  type AdminDraftState,
} from "../../lib/admin-server-draft";
import {
  reconcileDraftConflict,
  refreshAfterWriteConflict,
} from "../../lib/admin-draft-reconciliation";
import type { AdminApiFailure } from "../../lib/admin-api";
import type { AdminDraftOperation } from "../../lib/admin-server-draft";
import type { SiteContent } from "../../types/site-content";

/**
 * The editor's working-document controller (ESZ-107).
 *
 * Everything that coordinates the content being edited — the server draft
 * lifecycle, the dirty flag, the base revision snapshot and the edit-version
 * counter, failure handling and the whole conflict orchestration — lives here.
 * The page component keeps what only the page can own: the draft phase state
 * machine it renders (hosted here as inputs `draft`/`dispatch`, straight from
 * the `adminServerDraft` reducer), the backup device state, and the DOM.
 *
 * ## Why `content` is state and the base snapshot is a ref
 *
 * `content` has to be state because every keystroke re-renders the editors.
 * `baseContentRef` deliberately is not: it is read inside event handlers to
 * decide whether restored or imported content actually differs from what is
 * stored — a comparison that must not cause a render, and that would otherwise
 * mean stringifying the whole document on every keystroke. Both move together
 * and only when the server hands back an envelope: that pairing is what makes
 * the three-way reconciliation possible at all.
 *
 * ## The one cross-module seam
 *
 * The controller receives `writeLocalBackup` and `refreshBackupStatus` from
 * the local-backup unit instead of owning the device. The server flows that
 * are about to replace or lose the on-screen document (a 401, a reload, a 409
 * reconciliation, a reset) call the former with the current content; the
 * bootstrap effect calls the latter so the header can report that a backup
 * exists without ever applying it.
 */

/** Copy that more than one server flow shows, or that a test pins. */
export const EDITOR_MESSAGES = {
  unsavedBeforePublish:
    "Enregistrez le brouillon sur le serveur avant de publier : la publication publie ce qui est enregistré, pas ce qui est affiché ici.",
  publishConfirm:
    "Publier le brouillon enregistré sur le serveur ? Le site public affichera immédiatement ce contenu.",
  resetConfirm:
    "Remplacer le brouillon du serveur par le contenu actuellement publié ? Les modifications non publiées seront perdues. Le site public restera inchangé.",
  reloadConfirm:
    "Recharger le brouillon du serveur ? Le contenu affiché ici sera remplacé. Une sauvegarde locale de vos modifications est écrite avant le remplacement.",
  reconcileRetryConfirm:
    "Comparer à nouveau le contenu affiché ici avec le brouillon du serveur ? Rien ne sera écrit tant que la fusion n’est pas possible sans perte.",
  reconcileRaceLost:
    "Le brouillon du serveur a encore changé pendant la fusion. Rien n’a été écrit. Relancez la fusion : elle ne sera jamais rejouée automatiquement.",
  reconcileWithoutBase:
    "Impossible de fusionner : l’éditeur n’a pas de version de référence du serveur. Rechargez le brouillon du serveur — une sauvegarde locale de votre travail vient d’être écrite.",
} as const;

/**
 * What the local-backup unit may do to the working document.
 *
 * Passed per call rather than created in the backup hook: the document belongs
 * to this controller, so the backup unit receives a stable handle to it only
 * when a restore or import actually runs. `read()` returns the content as of
 * the last committed render (the same `contentRef` the server flows save);
 * `replace()` adopts a parsed backup/import as the working document, bumping
 * the edit version first so an in-flight save response cannot erase it;
 * `differsFromBase()` is the restore dirty decision — restoring content
 * identical to what the server already holds is not an edit.
 */
export interface EditorLocalDocument {
  read(): SiteContent;
  replace(next: SiteContent, markDirty: boolean): void;
  differsFromBase(candidate: SiteContent): boolean;
}

export interface ContentEditorControllerInput {
  defaultContent: SiteContent;
  /** The reducer state the page hosts and renders (phase, revision, copy). */
  draft: AdminDraftState;
  dispatch: Dispatch<AdminDraftAction>;
  /** Device backup from the local-backup unit; false when it could not write. */
  writeLocalBackup: (content: SiteContent) => boolean;
  /** Re-reads the device so the header reports whether a backup exists. */
  refreshBackupStatus: () => void;
}

export interface ContentEditorController {
  content: SiteContent;
  isDirty: boolean;
  /** The page's back-up/import/export buttons reach the document through it. */
  localDocument: EditorLocalDocument;
  updateContent(updater: (current: SiteContent) => SiteContent): void;
  loadServerDraft(): Promise<void>;
  handleSaveDraft(): Promise<void>;
  handlePublish(): Promise<void>;
  handleResetToPublished(): Promise<void>;
  handleReloadServerDraft(): Promise<void>;
  reconcileAfterSaveConflict(reportedRevision: number | null): Promise<void>;
}

function contentsEqual(first: SiteContent, second: SiteContent): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function useContentEditorController({
  defaultContent,
  draft,
  dispatch,
  writeLocalBackup,
  refreshBackupStatus,
}: ContentEditorControllerInput): ContentEditorController {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();

  const [content, setContent] = useState<SiteContent>(() =>
    cloneSiteContent(defaultContent),
  );
  const [isDirty, setIsDirty] = useState(false);

  /**
   * The base snapshot: the content of the revision `draft.revision` names.
   *
   * Kept in step with the revision by construction — both move together, and
   * only when the server hands back an envelope. That pairing is what makes the
   * three-way reconciliation possible at all: without a base, "who changed this
   * field" is unanswerable and the only recoveries left are the two lossy ones,
   * take-mine and take-theirs.
   */
  const baseContentRef = useRef<SiteContent | null>(null);

  /**
   * Counts edits so an in-flight response can tell whether it is still current.
   *
   * A save takes a round trip, and the admin can keep typing during it. Applying
   * the server's normalised copy unconditionally on return would delete every
   * keystroke made in that window — a data-loss bug that only appears on a slow
   * connection, which is exactly where it is least acceptable.
   */
  const editVersionRef = useRef(0);

  /**
   * The content as of the last commit, readable from a callback that was created
   * earlier. Updated in an effect rather than during render: a ref written while
   * rendering is one React is free to throw away.
   */
  const contentRef = useRef(content);
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    contentRef.current = content;
    isDirtyRef.current = isDirty;
  }, [content, isDirty]);

  /**
   * The single place a failed privileged call is turned into UI.
   *
   * Two side effects hang off it, and both are the difference between a useful
   * error and a dead screen: a 401 flips the whole admin area to the signed-out
   * notice, because every remaining button would 401 too; a 403 re-reads the
   * session, because `CSRF_TOKEN_INVALID` means the token rotated under a session
   * that is still perfectly alive and one refresh makes the next attempt work.
   */
  const reportFailure = useCallback(
    (operation: AdminDraftOperation, failure: AdminApiFailure) => {
      dispatch({ type: "operation-failed", operation, failure });

      if (failure.kind === "unauthenticated") {
        // Signing out replaces the whole admin area, which unmounts the editor
        // and everything in it. A session can end mid-edit — an idle tab, an
        // account disabled between two calls — so anything unsaved is written to
        // the device before the screen goes away. Without this the honest
        // handling of an expiry would itself be the data-loss path.
        if (isDirtyRef.current) writeLocalBackup(contentRef.current);
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") {
        void refreshSession();
      }
    },
    [dispatch, markExpired, refreshSession, writeLocalBackup],
  );

  const loadServerDraft = useCallback(async () => {
    dispatch({ type: "bootstrap-start" });

    const result = await api.readDraft();

    if (!result.ok) {
      reportFailure("loading", result.failure);
      return;
    }

    baseContentRef.current = cloneSiteContent(result.value.content);
    setContent(cloneSiteContent(result.value.content));
    setIsDirty(false);
    editVersionRef.current += 1;
    dispatch({ type: "draft-loaded", envelope: result.value });
  }, [api, dispatch, reportFailure]);

  // Bootstrap: the server draft is the source of truth, so it is read before the
  // editor renders any field. Whether a backup exists is then *reported* — read
  // after the server draft so the header can say "a backup from 14:32 exists"
  // without that backup ever becoming the content anyone is editing. The
  // published head is read last and best-effort — it only feeds the "what the
  // public sees" line, and a public endpoint being briefly unavailable must not
  // stop an admin from editing.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await loadServerDraft();
      if (cancelled) return;

      refreshBackupStatus();

      const published = await api.readPublished();
      if (cancelled) return;

      dispatch(
        published.ok
          ? { type: "published-loaded", envelope: published.value }
          : { type: "published-unknown" },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [api, dispatch, loadServerDraft, refreshBackupStatus]);

  /** Adopts a server envelope's content: revision and document move together. */
  function applyServerContent(next: SiteContent) {
    baseContentRef.current = cloneSiteContent(next);
    setContent(cloneSiteContent(next));
    setIsDirty(false);
    editVersionRef.current += 1;
  }

  /** Replaces the working document from a local restore or import. */
  function replaceLocalContent(next: SiteContent, markDirty: boolean) {
    editVersionRef.current += 1;
    setContent(cloneSiteContent(next));
    setIsDirty(markDirty);
  }

  const localDocument: EditorLocalDocument = useMemo(
    () => ({
      read: () => contentRef.current,
      replace: replaceLocalContent,
      differsFromBase: (candidate: SiteContent) =>
        baseContentRef.current === null ||
        !contentsEqual(candidate, baseContentRef.current),
    }),
    [],
  );

  function updateContent(updater: (current: SiteContent) => SiteContent) {
    editVersionRef.current += 1;
    setContent((current) => updater(current));
    setIsDirty(true);
    dispatch({
      type: "local-message",
      statusMessage:
        "Modifications non enregistrées. Elles ne sont ni sur le serveur ni publiées.",
    });
    dispatch({ type: "local-error", errorMessage: null });
  }

  async function handleSaveDraft() {
    if (!canWrite(draft) || draft.revision === null) return;

    const version = editVersionRef.current;
    dispatch({ type: "operation-start", operation: "saving" });

    const result = await api.saveDraft(
      { content: contentRef.current, expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      // A 409 is not an error to report and stop on: it is the start of the
      // reconciliation, which backs the local draft up before it does anything
      // else. Every other failure is terminal for this attempt.
      if (result.failure.kind === "conflict") {
        await reconcileAfterSaveConflict(result.failure.currentRevision);
        return;
      }
      reportFailure("saving", result.failure);
      return;
    }

    dispatch({ type: "draft-saved", envelope: result.value });

    if (editVersionRef.current === version) {
      // Nothing was typed while the request was in flight, so the server's
      // normalised copy can safely replace what is on screen.
      applyServerContent(result.value.content);
      return;
    }

    // Something was typed. The save succeeded and the revision has moved, but the
    // editor still holds newer text than the server: it stays dirty, and the
    // next save carries the revision this one just produced.
    baseContentRef.current = cloneSiteContent(result.value.content);
  }

  async function handlePublish() {
    if (!canWrite(draft) || draft.revision === null) return;

    if (isDirty) {
      dispatch({
        type: "local-error",
        errorMessage: EDITOR_MESSAGES.unsavedBeforePublish,
      });
      return;
    }

    if (!window.confirm(EDITOR_MESSAGES.publishConfirm)) return;

    dispatch({ type: "operation-start", operation: "publishing" });

    const result = await api.publish(
      { expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshAfterRefusedAction("publishing", result.failure);
        return;
      }
      reportFailure("publishing", result.failure);
      return;
    }

    dispatch({ type: "content-published", envelope: result.value });
  }

  async function handleResetToPublished() {
    if (!canWrite(draft) || draft.revision === null) return;
    if (!window.confirm(EDITOR_MESSAGES.resetConfirm)) return;

    if (isDirty) writeLocalBackup(contentRef.current);

    dispatch({ type: "operation-start", operation: "resetting" });

    const result = await api.resetDraft(
      { expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshAfterRefusedAction("resetting", result.failure);
        return;
      }
      reportFailure("resetting", result.failure);
      return;
    }

    applyServerContent(result.value.content);
    dispatch({ type: "draft-reset", envelope: result.value });
  }

  /** Conflict resolution, branch one: take the server's draft, keep a backup. */
  async function handleReloadServerDraft() {
    if (!window.confirm(EDITOR_MESSAGES.reloadConfirm)) return;

    writeLocalBackup(contentRef.current);

    dispatch({ type: "operation-start", operation: "loading" });

    const result = await api.readDraft();

    if (!result.ok) {
      reportFailure("loading", result.failure);
      return;
    }

    applyServerContent(result.value.content);
    dispatch({ type: "conflict-reloaded", envelope: result.value });
  }

  /**
   * Conflict resolution, branch two: reconcile against the server's *content*.
   *
   * This replaces the rebase that used to live here, which adopted the head named
   * in the 409 header and saved over it — a force-overwrite of a revision nobody
   * had read. The 409 stays exactly as authoritative as it was; what changes is
   * that recovery now goes and looks at what it collided with.
   *
   * Nothing is written unless the merge is clean, and the retry is single: a
   * second refusal means a third editor moved the head between the fetch and the
   * save, and a loop there would terminate only when everyone else stopped
   * typing.
   */
  async function reconcileAfterSaveConflict(reportedRevision: number | null) {
    const base = baseContentRef.current;

    if (base === null) {
      // No base snapshot means no three-way merge is possible — the editor never
      // completed a load. Back the work up and stop; the reload path is the only
      // honest offer left.
      writeLocalBackup(contentRef.current);
      reportFailure("saving", {
        kind: "conflict",
        message: EDITOR_MESSAGES.reconcileWithoutBase,
        currentRevision: reportedRevision,
      });
      return;
    }

    const version = editVersionRef.current;
    dispatch({ type: "operation-start", operation: "reconciling" });

    const outcome = await reconcileDraftConflict({
      base,
      local: contentRef.current,
      csrfToken,
      ports: api,
      backup: (content) => writeLocalBackup(content),
    });

    if (outcome.kind === "failed") {
      if (outcome.failure.kind === "conflict") {
        // The second race. Reported, never retried.
        reportFailure("saving", outcome.failure);
        dispatch({
          type: "local-error",
          errorMessage: EDITOR_MESSAGES.reconcileRaceLost,
        });
        return;
      }
      reportFailure(outcome.stage === "read" ? "loading" : "saving", outcome.failure);
      return;
    }

    if (outcome.kind === "unresolved") {
      dispatch({
        type: "conflict-unresolved",
        conflicts: outcome.conflicts,
        // From the fetched envelope, not from the 409 header — and it is still
        // only displayed, because nothing was merged and nothing was written.
        reportedServerRevision: outcome.serverEnvelope.revision,
      });
      return;
    }

    // Merged and saved, or already contained: either way the envelope carries the
    // revision *and* its content, which is the only thing the editor adopts.
    if (editVersionRef.current === version) {
      applyServerContent(outcome.content);
    } else {
      // Typing continued during the round trip. The reconciled document is the
      // new base, and the editor stays dirty so those keystrokes are still saved
      // by the next attempt rather than silently dropped.
      baseContentRef.current = cloneSiteContent(outcome.content);
    }

    dispatch(
      outcome.kind === "merged-saved"
        ? { type: "conflict-merged", envelope: outcome.envelope }
        : { type: "conflict-already-current", envelope: outcome.envelope },
    );
  }

  /**
   * What a refused publish or reset does: re-read, then wait to be asked again.
   *
   * There is no document to merge — both operations act on what is *stored* — so
   * the only question a 409 raises is whether the admin still means the action
   * now that the stored draft is a different one. That is not a question this
   * code may answer, so it refreshes the state and stops. No forcing, no silent
   * retry.
   */
  async function refreshAfterRefusedAction(
    operation: "publishing" | "resetting",
    failure: AdminApiFailure,
  ) {
    reportFailure(operation, failure);

    // Unsaved work is about to be at risk only if the fetched draft replaces the
    // screen, but the backup is free and the ordering has to be right the first
    // time.
    if (isDirtyRef.current) writeLocalBackup(contentRef.current);

    dispatch({ type: "operation-start", operation: "loading" });

    const refreshed = await refreshAfterWriteConflict(api);

    if (refreshed.kind === "failed") {
      reportFailure("loading", refreshed.failure);
      return;
    }

    // Replacing the on-screen document is only safe when there is nothing
    // unsaved on it. With unsaved edits the editor keeps them, keeps its stale
    // revision, and stays in the conflict phase — where reconciliation is the
    // offer, not a forced action.
    const contentAdopted = !isDirtyRef.current;
    if (contentAdopted) applyServerContent(refreshed.envelope.content);

    dispatch(
      refreshed.published
        ? { type: "published-loaded", envelope: refreshed.published }
        : { type: "published-unknown" },
    );
    dispatch({
      type: "conflict-refreshed",
      envelope: refreshed.envelope,
      operation,
      contentAdopted,
    });
  }

  return {
    content,
    isDirty,
    localDocument,
    updateContent,
    loadServerDraft,
    handleSaveDraft,
    handlePublish,
    handleResetToPublished,
    handleReloadServerDraft,
    reconcileAfterSaveConflict,
  };
}
