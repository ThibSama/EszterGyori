"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AdminPreviewViewport } from "./admin-preview-viewport";
import { AppearanceEditor } from "./appearance-editor";
import { MediaLibraryProvider } from "./media-library-provider";
import { useContentEditorBackup } from "./content-editor-backup";
import {
  EDITOR_MESSAGES,
  useContentEditorController,
} from "./content-editor-controller";
import {
  AboutEditor,
  ContactEditor,
  FooterEditor,
  GalleryEditor,
  HeroEditor,
  NavigationEditor,
  ProcessEditor,
  ReassuranceEditor,
  ServicesEditor,
} from "./content-editor-sections";
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
import {
  ADMIN_PREVIEW_SECTIONS,
  type AdminPreviewSectionKey,
} from "../../lib/admin-preview-sections";
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
 * - the section editors, pure presentation fed one section of the working
 *   document at a time.
 *
 * What stays here is the view: the loading screen, the header state lines, the
 * conflict banner, the action buttons, the scroll-spy section navigation, the
 * preview aside — and the single `MediaLibraryProvider` above every media
 * field, so every `MediaEditor` shares one fetch and one list (ESZ-037).
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

  const [activeSection, setActiveSection] =
    useState<AdminPreviewSectionKey>("hero");
  const explicitNavigationUntilRef = useRef(0);


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

  // Re-run once the editor fields exist. The sections are not in the document
  // while the server draft is loading, so an observer created on mount would
  // observe nothing and the section navigation would never highlight.
  useEffect(() => {
    if (draft.phase === "loading" || draft.phase === "unavailable") return;

    const observedSections = ADMIN_PREVIEW_SECTIONS.flatMap((section) => {
      const element = document.getElementById(section.editorTarget);
      return element ? [{ section, element }] : [];
    });

    if (observedSections.length === 0) return;

    const observer = new IntersectionObserver(
      () => {
        if (Date.now() < explicitNavigationUntilRef.current) return;

        const anchorY = 160;
        let nextSection = observedSections[0]?.section.key ?? null;
        let smallestPositiveDistance = Number.POSITIVE_INFINITY;

        for (const { section, element } of observedSections) {
          const rect = element.getBoundingClientRect();
          const distance = rect.top - anchorY;
          if (distance <= 0) {
            nextSection = section.key;
            continue;
          }

          if (nextSection === null && distance < smallestPositiveDistance) {
            smallestPositiveDistance = distance;
            nextSection = section.key;
          }
        }

        if (!nextSection) return;
        setActiveSection((current) =>
          current === nextSection ? current : nextSection,
        );
      },
      {
        root: null,
        rootMargin: "-128px 0px -45% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const { element } of observedSections) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
    };
  }, [draft.phase]);

  const handleSectionNavigation = useCallback(
    (section: (typeof ADMIN_PREVIEW_SECTIONS)[number]) => {
      explicitNavigationUntilRef.current = Date.now() + 2_000;
      setActiveSection(section.key);
      document.getElementById(section.editorTarget)?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      window.history.replaceState(null, "", `#${section.editorTarget}`);
    },
    [],
  );


  if (draft.phase === "loading" || draft.phase === "unavailable") {
    return (
      <main className="min-h-screen bg-warm-50 px-4 py-10 text-warm-800 sm:px-6">
        <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
          <div
            role="status"
            aria-live="polite"
            className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
            <h1 className="font-display text-2xl font-light text-warm-900">
              Éditeur de contenu Eszter
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-warm-700">
              {draft.statusMessage}
            </p>
            {draft.errorMessage && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {draft.errorMessage}
              </p>
            )}
            {draft.phase === "unavailable" && (
              <button
                type="button"
                onClick={() => {
                  void editor.loadServerDraft();
                }}
                className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
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
    <main className="min-h-screen bg-warm-50 text-warm-800">
      <div className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">
        <header className="mb-8 space-y-4">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-sage-600">
              Back-office
            </p>
            <h1 className="font-display text-4xl font-light text-warm-800">
              Éditeur de contenu Eszter
            </h1>
          </div>
          <div className="rounded-2xl border border-sage-300/70 bg-sage-100/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.05)]">
            <h2 className="font-display text-2xl font-normal text-warm-800">
              Brouillon enregistré sur le serveur
            </h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-warm-700">
              <p>
                Enregistrer envoie le brouillon au serveur : il est conservé pour
                tous les appareils et le site public n&apos;est pas modifié.
              </p>
              <p>
                Publier est une action distincte : c&apos;est elle, et elle seule,
                qui met le brouillon enregistré en ligne.
              </p>
              <p>
                La sauvegarde locale et le fichier JSON restent disponibles comme
                secours. Ils ne remplacent jamais le brouillon du serveur sans une
                action explicite.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-warm-300/70 bg-white/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)]">
            <p
              className="mb-3 inline-flex rounded-full bg-warm-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-porcelain"
              data-testid="admin-freshness">
              {ADMIN_DRAFT_FRESHNESS_LABELS[freshness]}
            </p>
            <div className="grid gap-3 text-sm text-warm-600 md:grid-cols-4">
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Modifications
                </span>
                {getModificationState(isDirty)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Brouillon serveur
                </span>
                {getServerDraftState(draft.revision, draft.updatedAt)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Site public
                </span>
                {getPublishedState(draft.publishedRevision, draft.publishedAt)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Sauvegarde locale
                </span>
                {getLocalBackupState(backupSavedAt)}
              </div>
            </div>
            <p
              className="mt-3 text-sm text-warm-600"
              role="status"
              aria-live="polite">
              {draft.statusMessage}
            </p>
            {draft.errorMessage && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {draft.errorMessage}
                {hasInvalidStoredBackup && (
                  <span className="block pt-1">
                    Vous pouvez supprimer cette sauvegarde locale ci-dessous.
                  </span>
                )}
              </div>
            )}

            {draft.phase === "conflict" && (
              <div
                role="alert"
                data-testid="admin-revision-conflict"
                className="mt-3 space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
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
                      au besoin sur l&apos;export JSON ci-dessous — puis relancez
                      la fusion. Rien ne sera écrit tant qu&apos;un chevauchement
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
                    className="inline-flex items-center justify-center rounded-full bg-warm-800 px-4 py-2 text-sm font-medium text-porcelain transition hover:bg-warm-700 disabled:cursor-not-allowed disabled:opacity-60">
                    Fusionner avec la version du serveur
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void editor.handleReloadServerDraft();
                    }}
                    disabled={draft.busy !== null}
                    className="inline-flex items-center justify-center rounded-full border border-amber-400 bg-white/80 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
                    Recharger la version du serveur
                  </button>
                </div>
              </div>
            )}

            <details className="mt-4 rounded-xl border border-warm-200 bg-warm-50/70 p-3 text-sm text-warm-600">
              <summary className="cursor-pointer font-medium text-warm-800">
                Informations techniques
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p>
                  Le brouillon fait autorité côté serveur. La sauvegarde de secours
                  de cet appareil utilise la clé suivante :
                </p>
                <code className="block break-all rounded-lg bg-white/80 px-3 py-2 text-xs text-warm-700">
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
          <div className="flex flex-col gap-3 rounded-2xl border border-warm-300/70 bg-white/65 p-4 sm:flex-row sm:flex-wrap sm:items-center">
            <a
              href="#preview"
              className="inline-flex items-center justify-center rounded-full bg-warm-800 px-5 py-2.5 text-sm font-medium text-porcelain transition hover:bg-warm-700">
              Voir l&apos;aperçu
            </a>
            <button
              type="button"
              onClick={() => {
                void editor.handleSaveDraft();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full bg-sage-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sage-700 disabled:cursor-not-allowed disabled:opacity-60">
              Enregistrer le brouillon
            </button>
            <button
              type="button"
              onClick={() => {
                void editor.handlePublish();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full bg-warm-900 px-5 py-2.5 text-sm font-medium text-porcelain transition hover:bg-warm-700 disabled:cursor-not-allowed disabled:opacity-60">
              Publier
            </button>
            <button
              type="button"
              onClick={() => {
                void editor.handleResetToPublished();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/70 px-5 py-2.5 text-sm font-medium text-warm-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
              Restaurer le contenu publié
            </button>
            <button
              type="button"
              onClick={() => handleSaveLocalBackup(editor.localDocument)}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Sauvegarder sur cet appareil
            </button>
            <button
              type="button"
              onClick={() => handleRestoreLocalBackup(editor.localDocument)}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Restaurer la sauvegarde locale
            </button>
            <button
              type="button"
              onClick={() => handleExportDraft(editor.localDocument)}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Exporter une sauvegarde JSON
            </button>
            <label
              htmlFor="admin-draft-import"
              className="inline-flex cursor-pointer items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
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
              className="inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100">
              Supprimer la sauvegarde locale
            </button>
            <div className="basis-full rounded-xl border border-warm-200 bg-warm-50/75 px-3 py-2 text-sm leading-relaxed text-warm-600">
              <span className="font-medium text-warm-800">
                Sauvegarde portable : fichier JSON.
              </span>{" "}
              Le fichier exporté peut être gardé comme sauvegarde, envoyé à une
              autre personne ou importé dans un autre navigateur. Il ne modifie le
              brouillon du serveur qu&apos;après un enregistrement explicite.
            </div>
          </div>
        </header>

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(480px,2fr)] xl:items-start 2xl:gap-8">
          <div className="min-w-0 space-y-6">
            <nav
              aria-label="Sections de l’éditeur"
              className="sticky top-[4.75rem] z-20 rounded-2xl border border-warm-200/80 bg-white/85 p-3 shadow-[0_8px_24px_rgba(44,43,40,0.06)] backdrop-blur">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {ADMIN_PREVIEW_SECTIONS.map((section) => (
                  <a
                    key={section.key}
                    href={`#${section.editorTarget}`}
                    aria-current={
                      activeSection === section.key ? "true" : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      handleSectionNavigation(section);
                    }}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 ${
                      activeSection === section.key
                        ? "border-warm-800 bg-warm-800 text-porcelain"
                        : "border-warm-200 bg-warm-50/80 text-warm-600 hover:border-sage-300 hover:bg-white hover:text-warm-900"
                    }`}>
                    {section.label}
                  </a>
                ))}
              </div>
            </nav>
            <AppearanceEditor
              appearance={content.appearance}
              onChange={(appearance) =>
                editor.updateContent((current) => ({ ...current, appearance }))
              }
              onError={(errorMessage) =>
                dispatch({ type: "local-error", errorMessage })
              }
            />
            <NavigationEditor
              content={content.navigation}
              onChange={(navigation) =>
                editor.updateContent((current) => ({ ...current, navigation }))
              }
            />
            <HeroEditor
              content={content.hero}
              onChange={(hero) =>
                editor.updateContent((current) => ({ ...current, hero }))
              }
            />
            <ReassuranceEditor
              content={content.reassurance}
              onChange={(reassurance) =>
                editor.updateContent((current) => ({ ...current, reassurance }))
              }
            />
            <ServicesEditor
              content={content.services}
              onChange={(services) =>
                editor.updateContent((current) => ({ ...current, services }))
              }
            />
            <ProcessEditor
              content={content.process}
              onChange={(process) =>
                editor.updateContent((current) => ({ ...current, process }))
              }
            />
            <GalleryEditor
              content={content.gallery}
              onChange={(gallery) =>
                editor.updateContent((current) => ({ ...current, gallery }))
              }
            />
            <AboutEditor
              content={content.about}
              onChange={(about) =>
                editor.updateContent((current) => ({ ...current, about }))
              }
            />
            <ContactEditor
              content={content.contact}
              onChange={(contact) =>
                editor.updateContent((current) => ({ ...current, contact }))
              }
            />
            <FooterEditor
              content={content.footer}
              onChange={(footer) =>
                editor.updateContent((current) => ({ ...current, footer }))
              }
            />
          </div>

          <aside
            id="preview"
            className="min-w-0 xl:sticky xl:top-[5.25rem] xl:h-[calc(100vh-6.5rem)]">
            <AdminPreviewViewport
              content={content}
              activeSection={activeSection}
            />
          </aside>
        </div>

        <p className="mt-8 text-xs text-warm-400">
          Référence initiale chargée : {initialContent.navigation.brandLabel}.
          Les IDs techniques restent disponibles au rendu mais ne sont pas
          éditables.
        </p>
      </div>
    </main>
    </MediaLibraryProvider>
  );
}
