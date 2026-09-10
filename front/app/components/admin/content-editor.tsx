"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { MediaLibraryProvider } from "./media-library-provider";
import { useContentEditorBackup } from "./content-editor-backup";
import {
  EDITOR_MESSAGES,
  useContentEditorController,
} from "./content-editor-controller";
import {
  ContentWorkspace,
  type WorkspaceView,
} from "./content-workspace";
import { cloneSiteContent } from "../../lib/site-content-clone";
import { SITE_CONTENT_DRAFT_STORAGE_KEY } from "../../lib/admin-draft-storage";
import {
  ADMIN_DRAFT_FRESHNESS_LABELS,
  ADMIN_DRAFT_MESSAGES,
  adminDraftReducer,
  canWrite,
  createInitialDraftState,
  describeDraftFreshness,
} from "../../lib/admin-server-draft";
import { describeMergeConflict } from "../../lib/site-content-merge";
import type { SiteContent } from "../../types/site-content";

interface ContentEditorProps {
  defaultContent: SiteContent;
}

/**
 * The page-level orchestrator of the admin content editor (ESZ-107).
 *
 * It composes the three units the editor is built from and owns everything
 * that only the page can own:
 *
 * - `useContentEditorController` — the working document, the server draft
 *   lifecycle and the conflict orchestration (the draft phase state machine it
 *   drives is the `adminServerDraft` reducer, hosted here and rendered in the
 *   header and conflict banner);
 * - `useContentEditorBackup` — the explicit device backup and the JSON
 *   import/export flows, which reach the working document through
 *   `editor.localDocument` when a restore or import actually runs;
 * - `ContentWorkspace` — the focused editing surface (ESZ-156): the page/section
 *   navigation, the one selected section editor and the live preview. It is
 *   given the working document and the controller's `updateContent`, so the
 *   focused rendering is a view over the same single draft rather than a state
 *   of its own.
 *
 * What stays here is the view around that surface: the loading screen, the
 * header state lines, the conflict banner, the action buttons — and the single
 * `MediaLibraryProvider` above every media field, so every `MediaEditor` shares
 * one fetch and one list (ESZ-037).
 *
 * ESZ-157 ranked those actions without changing any of them. The header is now
 * two regions: a primary card carrying the draft state, Save, Preview, Publish
 * and — always expanded — the conflict banner; and a collapsed, visually quieter
 * `<details>` holding the recovery controls (revert to published, device backup,
 * JSON import/export, the storage-key note). The handlers, the `canWrite` gate,
 * the reducer and the revision contract are untouched: only where a control sits
 * and how loud it looks changed.
 *
 * ESZ-156 changed where the section editors are mounted and nothing about what
 * they save: `updateContent` still commits to one whole `SiteContent`, and a save
 * still sends that whole document. A section nobody has opened this session is in
 * the payload exactly as the server draft delivered it.
 */


function formatFrenchDateTime(isoDate: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoDate));
}


function getModificationState(isDirty: boolean): string {
  return isDirty ? "Modifications non enregistrées" : "Aucune modification non enregistrée";
}

/** The server draft line: which revision this editor is based on, and when. */
function getServerDraftState(
  revision: number | null,
  updatedAt: string | null,
): string {
  if (revision === null) return "Aucun brouillon serveur chargé";
  const stamp = updatedAt ? ` — ${formatFrenchDateTime(updatedAt)}` : "";
  return `Révision ${revision}${stamp}`;
}

/** The public line: what visitors are actually being served right now. */
function getPublishedState(
  publishedRevision: number | null,
  publishedAt: string | null,
): string {
  if (publishedRevision === null) return "État de publication inconnu";
  const stamp = publishedAt ? ` — ${formatFrenchDateTime(publishedAt)}` : "";
  return `Révision publiée ${publishedRevision}${stamp}`;
}

/** The local backup line. Explicitly secondary: it is never the source of truth. */
function getLocalBackupState(backupSavedAt: string | null): string {
  return backupSavedAt
    ? `Sauvegarde locale du ${formatFrenchDateTime(backupSavedAt)}`
    : "Aucune sauvegarde locale sur cet appareil";
}

export function ContentEditor({ defaultContent }: ContentEditorProps) {
  const [draft, dispatch] = useReducer(
    adminDraftReducer,
    undefined,
    createInitialDraftState,
  );
  const {
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
  } = useContentEditorBackup({ dispatch });
  const editor = useContentEditorController({
    defaultContent,
    draft,
    dispatch,
    writeLocalBackup,
    refreshBackupStatus: refreshStatus,
  });
  const { content, isDirty } = editor;
  const initialContent = useMemo(
    () => cloneSiteContent(defaultContent),
    [defaultContent],
  );

  /**
   * Which panel the focused workspace shows where both do not fit (ESZ-156).
   *
   * It lives here rather than inside the workspace for one reason: the header's
   * “Voir l’aperçu” has to reach the preview on a narrow screen too, and below
   * `xl` the preview is a mode rather than a column. Owning the mode here keeps
   * that one control honest at every width without giving the workspace a second
   * way to be told what to show.
   */
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("editor");

  /**
   * Whether the subordinate backup/recovery region is open (ESZ-157).
   *
   * Closed by default, because none of what it holds belongs to an ordinary
   * editing pass. One state overrides that choice rather than being hidden
   * behind it: a stored backup that cannot be read, whose only remedy — deleting
   * it — is a button inside this region. The override is derived, not written
   * into state by an effect, so the region reverts to the operator's own choice
   * the moment the unreadable backup is gone.
   *
   * It stays a `<details>` either way: the summary is a native tab stop and the
   * disclosure is the browser's, not a scripted one.
   */
  const [hasOpenedRecovery, setHasOpenedRecovery] = useState(false);
  const isRecoveryOpen = hasOpenedRecovery || hasInvalidStoredBackup;

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty]);

  /**
   * The header's jump to the preview.
   *
   * It shows the preview panel first — on a narrow screen it is not in the
   * document until it is the selected mode — and scrolls to it once React has
   * rendered it. On a wide screen the panel is already there and only the scroll
   * runs.
   */
  const handleShowPreview = useCallback(() => {
    setWorkspaceView("preview");
    requestAnimationFrame(() => {
      document.getElementById("preview")?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }, []);

  if (draft.phase === "loading" || draft.phase === "unavailable") {
    return (
      <main className="admin-canvas min-h-screen px-4 py-10 sm:px-6">
        <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
          <div
            role="status"
            aria-live="polite"
            className="admin-panel rounded-3xl p-6 sm:p-8">
            <h1 className="admin-text font-display text-2xl font-light">
              Éditeur de contenu Eszter
            </h1>
            <p className="admin-text-muted mt-3 text-sm leading-relaxed">
              {draft.statusMessage}
            </p>
            {draft.errorMessage && (
              <p
                role="alert"
                className="admin-note-danger mt-3 rounded-xl px-3 py-2 text-sm">
                {draft.errorMessage}
              </p>
            )}
            {draft.phase === "unavailable" && (
              <button
                type="button"
                onClick={() => {
                  void editor.loadServerDraft();
                }}
                className="admin-btn-primary mt-6 inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                Réessayer
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  const freshness = describeDraftFreshness(draft, isDirty);
  const writesAllowed = canWrite(draft);

  return (
    // The library is provided once, above every media field, so the four
    // `MediaEditor`s share one fetch and one list rather than four of each
    // (ESZ-037). It is given the working document so the delete control can warn
    // that an asset is still in use; it never writes one.
    <MediaLibraryProvider content={content}>
    <main className="admin-canvas min-h-screen">
      <div className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">
        <header className="mb-8 space-y-4">
          <div>
            <p className="admin-text-accent text-sm font-medium uppercase tracking-wide">
              Back-office
            </p>
            <h1 className="admin-text font-display text-4xl font-light">
              Éditeur de contenu Eszter
            </h1>
          </div>

          {/*
            The primary action area (ESZ-157).

            One card carries, in this order, the four things an editing session is
            actually about: what state the draft is in, saving it, looking at it,
            and publishing it. Everything that exists for recovery rather than for
            editing — the device backup, the JSON file, the revert to the published
            content — is in the subordinate region below, and nothing here changed
            about what those controls do or when they are allowed to run: the
            handlers, the `canWrite` gate and the reducer are the accepted ones.
          */}
          <section
            aria-labelledby="cms-primary-actions-title"
            data-testid="admin-primary-actions"
            className="admin-panel admin-border-strong rounded-2xl p-4 sm:p-5">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <h2
                  id="cms-primary-actions-title"
                  className="admin-text-subtle text-xs font-medium uppercase tracking-[0.18em]">
                  Brouillon enregistré sur le serveur
                </h2>
                <p
                  className="admin-freshness-badge mt-2 inline-flex rounded-full px-4 py-1.5 font-display text-lg font-normal leading-tight"
                  data-testid="admin-freshness">
                  {ADMIN_DRAFT_FRESHNESS_LABELS[freshness]}
                </p>
                <div className="admin-text-muted mt-3 grid gap-3 text-sm sm:grid-cols-3">
                  <div className="admin-sunken rounded-xl p-3">
                    <span className="admin-text block font-medium">
                      Modifications
                    </span>
                    {getModificationState(isDirty)}
                  </div>
                  <div className="admin-sunken rounded-xl p-3">
                    <span className="admin-text block font-medium">
                      Brouillon serveur
                    </span>
                    {getServerDraftState(draft.revision, draft.updatedAt)}
                  </div>
                  <div className="admin-sunken rounded-xl p-3">
                    <span className="admin-text block font-medium">
                      Site public
                    </span>
                    {getPublishedState(draft.publishedRevision, draft.publishedAt)}
                  </div>
                </div>
              </div>

              {/*
                Save, preview, publish — and nothing else. Each keeps the handler
                and the `writesAllowed` gate it already had; a disabled button
                here means the same thing it meant before (a write in flight, no
                known revision, or an ended session).
              */}
              <div
                data-testid="admin-primary-action-buttons"
                className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap xl:w-[22rem] xl:flex-col">
                <button
                  type="button"
                  onClick={() => {
                    void editor.handleSaveDraft();
                  }}
                  disabled={!writesAllowed}
                  className="admin-btn-primary inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed">
                  Enregistrer le brouillon
                </button>
                <button
                  type="button"
                  onClick={handleShowPreview}
                  className="admin-btn-secondary inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Voir l&apos;aperçu
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void editor.handlePublish();
                  }}
                  disabled={!writesAllowed}
                  className="admin-btn-strong inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed">
                  Publier
                </button>
              </div>
            </div>

            <p
              className="admin-text-muted mt-4 text-sm"
              role="status"
              aria-live="polite">
              {draft.statusMessage}
            </p>

            {draft.errorMessage && (
              <div
                role="alert"
                className="admin-note-danger mt-3 rounded-xl px-3 py-2 text-sm">
                {draft.errorMessage}
                {hasInvalidStoredBackup && (
                  <span className="block pt-1">
                    Vous pouvez supprimer cette sauvegarde locale dans
                    «&nbsp;Sauvegardes et récupération&nbsp;» ci-dessous.
                  </span>
                )}
              </div>
            )}

            {/*
              The conflict stays here, in the primary area, expanded and next to
              the buttons it blocks. It is never inside the collapsible region
              below: a refused save is the one thing an operator must not have to
              go looking for.
            */}
            {draft.phase === "conflict" && (
              <div
                role="alert"
                data-testid="admin-revision-conflict"
                className="admin-note-warn mt-3 space-y-3 rounded-xl px-3 py-3 text-sm">
                <p className="font-medium">
                  {draft.conflicts.length > 0
                    ? ADMIN_DRAFT_MESSAGES.conflictUnresolved
                    : ADMIN_DRAFT_MESSAGES.conflict}
                </p>
                <p>
                  Votre version : révision {draft.revision ?? "inconnue"}. Version
                  du serveur :{" "}
                  {draft.reportedServerRevision === null
                    ? "inconnue"
                    : `révision ${draft.reportedServerRevision}`}
                  . Rien n&apos;a été écrit sur le serveur.
                </p>
                {draft.conflicts.length > 0 && (
                  <div data-testid="admin-merge-conflicts">
                    <p className="font-medium">
                      Éléments modifiés des deux côtés :
                    </p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {draft.conflicts.map((conflict) => (
                        <li key={`${conflict.kind}:${conflict.path.join(".")}`}>
                          {describeMergeConflict(conflict)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2">
                      Reprenez ces éléments dans l&apos;éditeur — en vous appuyant
                      au besoin sur l&apos;export JSON, à ouvrir depuis
                      «&nbsp;Sauvegardes et récupération&nbsp;» — puis relancez la
                      fusion. Rien ne sera écrit tant qu&apos;un chevauchement
                      subsiste.
                    </p>
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm(EDITOR_MESSAGES.reconcileRetryConfirm)) {
                        return;
                      }
                      void editor.reconcileAfterSaveConflict(draft.reportedServerRevision);
                    }}
                    disabled={draft.busy !== null}
                    className="admin-btn-strong inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed">
                    Fusionner avec la version du serveur
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void editor.handleReloadServerDraft();
                    }}
                    disabled={draft.busy !== null}
                    className="admin-btn-secondary inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed">
                    Recharger la version du serveur
                  </button>
                </div>
              </div>
            )}

            <p className="admin-border admin-text-subtle mt-4 border-t pt-3 text-xs leading-relaxed">
              Enregistrer envoie le brouillon au serveur : il est conservé pour
              tous les appareils et le site public n&apos;est pas modifié.{" "}
              Publier est une action distincte : c&apos;est elle, et elle seule,
              qui met le brouillon enregistré en ligne.
            </p>
          </section>

          {/*
            The subordinate region (ESZ-157).

            Visually quieter and collapsed by default, but a real disclosure: the
            `summary` is a native tab stop, so every control inside is two keys
            away, and nothing that blocks a save lives in here. It opens itself
            when the stored backup is unreadable, because that is the one state in
            here an operator has to act on and the fix is one of these buttons.
          */}
          <details
            open={isRecoveryOpen}
            onToggle={(event) => setHasOpenedRecovery(event.currentTarget.open)}
            data-testid="admin-recovery-tools"
            className="admin-panel-quiet rounded-2xl px-4 py-3">
            <summary className="admin-text-muted cursor-pointer rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-sage-300">
              Sauvegardes et récupération
            </summary>
            <div className="mt-3 space-y-3">
              <p className="admin-text-muted text-sm leading-relaxed">
                Le brouillon du serveur fait autorité. La sauvegarde locale et le
                fichier JSON sont des secours : ils ne remplacent jamais le
                brouillon du serveur sans une action explicite de votre part.
              </p>
              <div className="admin-sunken rounded-xl p-3 text-sm">
                <span className="admin-text block font-medium">
                  Sauvegarde locale
                </span>
                {getLocalBackupState(backupSavedAt)}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button
                  type="button"
                  onClick={() => {
                    void editor.handleResetToPublished();
                  }}
                  disabled={!writesAllowed}
                  className="admin-btn-quiet inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed">
                  Restaurer le contenu publié
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveLocalBackup(editor.localDocument)}
                  className="admin-btn-secondary inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Sauvegarder sur cet appareil
                </button>
                <button
                  type="button"
                  onClick={() => handleRestoreLocalBackup(editor.localDocument)}
                  className="admin-btn-secondary inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Restaurer la sauvegarde locale
                </button>
                <button
                  type="button"
                  onClick={() => handleExportDraft(editor.localDocument)}
                  className="admin-btn-secondary inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Exporter une sauvegarde JSON
                </button>
                <label
                  htmlFor="admin-draft-import"
                  className="admin-btn-secondary inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus-within:ring-2 focus-within:ring-sage-300">
                  Importer un fichier JSON
                </label>
                <input
                  ref={fileInputRef}
                  id="admin-draft-import"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    void handleImportDraft(event.target.files?.[0], editor.localDocument);
                  }}
                  className="sr-only"
                />
                <button
                  type="button"
                  onClick={() => handleDeleteLocalBackup()}
                  className="admin-btn-danger inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Supprimer la sauvegarde locale
                </button>
              </div>
              <div className="admin-sunken rounded-xl px-3 py-2 text-sm leading-relaxed">
                <span className="admin-text font-medium">
                  Sauvegarde portable : fichier JSON.
                </span>{" "}
                Le fichier exporté peut être gardé comme sauvegarde, envoyé à une
                autre personne ou importé dans un autre navigateur. Il ne modifie
                le brouillon du serveur qu&apos;après un enregistrement explicite.
              </div>

              <details className="admin-sunken rounded-xl p-3 text-sm">
                <summary className="admin-text cursor-pointer rounded-lg font-medium focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Informations techniques
                </summary>
                <div className="mt-2 space-y-2 leading-relaxed">
                  <p>
                    Le brouillon fait autorité côté serveur. La sauvegarde de
                    secours de cet appareil utilise la clé suivante :
                  </p>
                  <code className="admin-panel admin-text-muted block break-all rounded-lg px-3 py-2 text-xs">
                    {SITE_CONTENT_DRAFT_STORAGE_KEY}
                  </code>
                  <p>
                    Aucun identifiant de session ni jeton de sécurité n&apos;est
                    conservé dans le navigateur : la session est un cookie que la
                    page ne peut pas lire.
                  </p>
                </div>
              </details>
            </div>
          </details>
        </header>

        <ContentWorkspace
          content={content}
          onUpdate={editor.updateContent}
          onError={(errorMessage) =>
            dispatch({ type: "local-error", errorMessage })
          }
          view={workspaceView}
          onViewChange={setWorkspaceView}
        />

        <p className="admin-text-subtle mt-8 text-xs">
          Référence initiale chargée : {initialContent.navigation.brandLabel}.
          Les IDs techniques restent disponibles au rendu mais ne sont pas
          éditables.
        </p>
      </div>
    </main>
    </MediaLibraryProvider>
  );
}
