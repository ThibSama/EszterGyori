"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdminPreviewViewport } from "./admin-preview-viewport";
import { AppearanceEditor } from "./appearance-editor";
import { ContentSectionNavigation } from "./content-section-navigation";
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
import {
  DEFAULT_ADMIN_CONTENT_SELECTION,
  adminContentArea,
  adminContentSection,
  adminContentSectionDescription,
  contentSelectionHash,
  parseContentSelectionHash,
  resolveContentSelection,
  selectContentArea,
  type AdminContentAreaKey,
  type AdminContentSectionKey,
  type AdminContentSelection,
} from "../../lib/admin-content-navigation";
import type { SiteContent } from "../../types/site-content";

/**
 * The focused editing workspace of the CMS (ESZ-156).
 *
 * The editor used to render all ten section editors down one page; it now renders
 * exactly one, the one the navigation selects. Three things are worth stating
 * about that, because each is a property the tests pin rather than a styling
 * choice:
 *
 * - the unselected editors are *absent*, not hidden. Hiding them with CSS would
 *   leave every field of every section in the tab order and in the accessibility
 *   tree, which is the bug the focused editor exists to remove, only invisible;
 * - the draft is untouched by navigation. The working document lives one level up
 *   in `useContentEditorController`, and this component only ever reads it and
 *   hands edits back through `onUpdate` — so changing section changes which
 *   editor is mounted and nothing else. Edits made in a section that is no longer
 *   rendered are still in the document, still dirty, still in the save payload;
 * - there is one content state, and the preview is fed from it directly. The
 *   preview is the existing `AdminPreviewViewport` over the existing postMessage
 *   pipeline, given the same `content` object the editor is editing, so it shows
 *   unsaved edits by construction rather than by synchronisation.
 *
 * Below `xl` the preview cannot sit beside the editor without making both
 * unusable, so it becomes an explicit mode instead of a squeezed column: one
 * switch, one state, and the same single content document behind either mode.
 * The mode is decided from a media query rather than from CSS classes precisely
 * so the panel that is not shown is not rendered.
 */

const WIDE_WORKSPACE_QUERY = "(min-width: 1280px)";

export type WorkspaceView = "editor" | "preview";

export function ContentWorkspace({
  content,
  onUpdate,
  onError,
  view,
  onViewChange,
}: {
  content: SiteContent;
  onUpdate: (updater: (current: SiteContent) => SiteContent) => void;
  onError: (message: string | null) => void;
  /**
   * Which panel the narrow layout shows. Owned by the page so the header's
   * “Voir l’aperçu” reaches the preview at every width rather than pointing at
   * an anchor that only exists on a wide screen.
   */
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const [selection, setSelection] = useState<AdminContentSelection>(
    DEFAULT_ADMIN_CONTENT_SELECTION,
  );
  const [isWideWorkspace, setIsWideWorkspace] = useState(false);
  const hasReadHashRef = useRef(false);

  // The address bar is read once, on mount, rather than during render: the page
  // is prerendered as a static file, so resolving the hash while rendering would
  // hydrate a different section than the server wrote and React would throw the
  // tree away. A stale or unknown hash resolves to the default rather than to an
  // error — `parseContentSelectionHash` is total.
  useEffect(() => {
    if (hasReadHashRef.current) return;
    hasReadHashRef.current = true;
    setSelection(parseContentSelectionHash(window.location.hash));
  }, []);

  // Keeps the address bar on the section being edited, so a reload comes back to
  // it. `replaceState` rather than `pushState`: choosing a section is navigation
  // inside one screen, and giving each one a history entry would turn the browser
  // Back button into an editor-section stepper.
  useEffect(() => {
    const hash = contentSelectionHash(selection);
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", hash);
    }
  }, [selection]);

  // A hash typed or opened from a bookmark still has to land somewhere valid.
  useEffect(() => {
    const handleHashChange = () => {
      setSelection(parseContentSelectionHash(window.location.hash));
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia(WIDE_WORKSPACE_QUERY);
    const sync = () => setIsWideWorkspace(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
    };
  }, []);

  const handleSelectArea = useCallback((area: AdminContentAreaKey) => {
    setSelection((current) => selectContentArea(current, area));
  }, []);

  const handleSelectSection = useCallback((section: AdminContentSectionKey) => {
    setSelection((current) =>
      current.section === section ? current : resolveContentSelection({ section }),
    );
  }, []);

  const area = adminContentArea(selection.area);
  const section = adminContentSection(selection.section);
  // Wide enough for both: the mode switch has nothing left to switch, so it is
  // not rendered and both panels are.
  const showsEditor = isWideWorkspace || view === "editor";
  const showsPreview = isWideWorkspace || view === "preview";

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,15rem)_minmax(0,3fr)_minmax(420px,2fr)] 2xl:gap-8">
      <ContentSectionNavigation
        selection={selection}
        onSelectArea={handleSelectArea}
        onSelectSection={handleSelectSection}
      />

      {showsEditor && (
        <div className="min-w-0 space-y-4" data-testid="cms-editor-panel">
          <div className="admin-panel flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="admin-text-subtle text-xs font-medium uppercase tracking-[0.18em]">
                {area.label}
              </p>
              <h2
                data-testid="cms-selected-section"
                className="admin-text font-display text-2xl font-normal">
                {section.label}
              </h2>
              <p className="admin-text-muted mt-1 text-sm leading-relaxed">
                {adminContentSectionDescription(selection.section)}
              </p>
            </div>
            {!isWideWorkspace && (
              <WorkspaceViewSwitch view={view} onChange={onViewChange} />
            )}
          </div>

          {/* Exactly one section editor, chosen by the selection. */}
          <ContentSectionEditor
            section={selection.section}
            content={content}
            onUpdate={onUpdate}
            onError={onError}
          />
        </div>
      )}

      {showsPreview && (
        <aside
          id="preview"
          data-testid="cms-preview-panel"
          className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)]">
          {!isWideWorkspace && (
            <div className="admin-panel flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="admin-text-subtle text-xs font-medium uppercase tracking-[0.18em]">
                  Aperçu — {area.label}
                </p>
                <p className="admin-text-muted text-sm leading-relaxed">
                  Section en cours d’édition : {section.label}. Les modifications
                  non enregistrées sont visibles ici.
                </p>
              </div>
              <WorkspaceViewSwitch view={view} onChange={onViewChange} />
            </div>
          )}
          <AdminPreviewViewport
            content={content}
            activeSection={selection.section}
          />
        </aside>
      )}
    </div>
  );
}

/**
 * The Editor/Preview switch, below `xl` only.
 *
 * Two buttons rather than a drawer or a modal: the preview replaces the editor
 * panel in place, so there is nothing to trap focus in and nothing to dismiss.
 * Switching mounts the other panel over the same content state — no edit can be
 * lost by looking at the preview, because the document is not held in the DOM.
 */
function WorkspaceViewSwitch({
  view,
  onChange,
}: {
  view: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Mode de travail"
      data-testid="cms-view-switch"
      className="admin-segmented grid shrink-0 grid-cols-2 rounded-full p-1">
      {(
        [
          { value: "editor", label: "Éditeur" },
          { value: "preview", label: "Aperçu" },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          data-cms-view={option.value}
          onClick={() => onChange(option.value)}
          className="admin-segmented-option h-10 min-w-0 rounded-full px-4 text-center text-sm leading-none transition focus:outline-none focus:ring-2 focus:ring-sage-300">
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The one place a section key becomes an editor.
 *
 * The mapping is a `switch` rather than a lookup table so the compiler checks it
 * is exhaustive: adding a section to the content document without an editor here
 * fails the build instead of rendering an empty panel. Each branch is the same
 * specialised editor the long page rendered, given the same slice of the same
 * document and the same `onChange` — the field logic is not duplicated, adapted
 * or regenerated, only mounted one at a time.
 */
function ContentSectionEditor({
  section,
  content,
  onUpdate,
  onError,
}: {
  section: AdminContentSectionKey;
  content: SiteContent;
  onUpdate: (updater: (current: SiteContent) => SiteContent) => void;
  onError: (message: string | null) => void;
}) {
  switch (section) {
    case "appearance":
      return (
        <AppearanceEditor
          appearance={content.appearance}
          onChange={(appearance) =>
            onUpdate((current) => ({ ...current, appearance }))
          }
          onError={onError}
        />
      );
    case "navigation":
      return (
        <NavigationEditor
          content={content.navigation}
          onChange={(navigation) =>
            onUpdate((current) => ({ ...current, navigation }))
          }
        />
      );
    case "hero":
      return (
        <HeroEditor
          content={content.hero}
          onChange={(hero) => onUpdate((current) => ({ ...current, hero }))}
        />
      );
    case "reassurance":
      return (
        <ReassuranceEditor
          content={content.reassurance}
          onChange={(reassurance) =>
            onUpdate((current) => ({ ...current, reassurance }))
          }
        />
      );
    case "services":
      return (
        <ServicesEditor
          content={content.services}
          onChange={(services) =>
            onUpdate((current) => ({ ...current, services }))
          }
        />
      );
    case "process":
      return (
        <ProcessEditor
          content={content.process}
          onChange={(process) => onUpdate((current) => ({ ...current, process }))}
        />
      );
    case "gallery":
      return (
        <GalleryEditor
          content={content.gallery}
          onChange={(gallery) => onUpdate((current) => ({ ...current, gallery }))}
        />
      );
    case "about":
      return (
        <AboutEditor
          content={content.about}
          onChange={(about) => onUpdate((current) => ({ ...current, about }))}
        />
      );
    case "contact":
      return (
        <ContactEditor
          content={content.contact}
          onChange={(contact) => onUpdate((current) => ({ ...current, contact }))}
        />
      );
    case "footer":
      return (
        <FooterEditor
          content={content.footer}
          onChange={(footer) => onUpdate((current) => ({ ...current, footer }))}
        />
      );
  }
}
