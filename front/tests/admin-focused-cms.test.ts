import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ADMIN_CONTENT_AREAS,
  DEFAULT_ADMIN_CONTENT_SELECTION,
  adminContentArea,
  adminContentSection,
  adminContentSectionDescription,
  areaKeyForContentSection,
  contentSelectionHash,
  isAdminContentAreaKey,
  parseContentSelectionHash,
  resolveContentSelection,
  selectContentArea,
  type AdminContentSectionKey,
} from "../app/lib/admin-content-navigation";
import {
  ADMIN_PREVIEW_SECTION_KEYS,
} from "../app/lib/admin-preview-sections";

/**
 * The focused CMS (ESZ-156).
 *
 * `/admin/content` stopped being one long page of every section editor and became
 * a structured editor: choose an area, choose a section, edit that section, watch
 * it in the preview. The properties that makes safe are asserted here.
 *
 * The selection model is pure, so most of this is behaviour rather than shape: it
 * resolves real inputs — stale hashes, mismatched pairs, junk — and the results
 * are the ones the workspace renders. What cannot be executed here (a section
 * editor is a client component, and this suite runs under
 * `--conditions=react-server`) is asserted structurally and then proven for real
 * in `scripts/browser-admin.mjs`, which drives the live editor in a browser:
 * one visible section, an edit that survives navigating away and back, and a
 * preview that shows it before anything is saved.
 */

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const workspaceSource = readAppFile("components", "admin", "content-workspace.tsx");
const navigationSource = readAppFile(
  "components",
  "admin",
  "content-section-navigation.tsx",
);
const editorSource = readAppFile("components", "admin", "content-editor.tsx");

/** Every section editor the long page used to render, and what mounts each. */
const SECTION_EDITORS: Record<AdminContentSectionKey, string> = {
  appearance: "AppearanceEditor",
  navigation: "NavigationEditor",
  hero: "HeroEditor",
  reassurance: "ReassuranceEditor",
  services: "ServicesEditor",
  process: "ProcessEditor",
  gallery: "GalleryEditor",
  about: "AboutEditor",
  contact: "ContactEditor",
  footer: "FooterEditor",
};

// ── The navigation model ───────────────────────────────────────────────────

test("the areas partition the content document's sections exactly once", () => {
  const listed = ADMIN_CONTENT_AREAS.flatMap((area) => area.sections);

  // Not a subset and not a superset: a section missing from every area would be
  // uneditable, and one listed twice would give the same editor two homes.
  assert.deepEqual(
    [...listed].sort(),
    [...ADMIN_PREVIEW_SECTION_KEYS].sort(),
    "the areas do not cover the content sections exactly",
  );
  assert.equal(new Set(listed).size, listed.length, "a section is listed twice");

  for (const area of ADMIN_CONTENT_AREAS) {
    assert.ok(area.sections.length > 0, `${area.key} has no section`);
    assert.ok(area.label.length > 0 && area.description.length > 0);
    for (const section of area.sections) {
      assert.equal(areaKeyForContentSection(section), area.key);
    }
  }

  // Area keys are unique and stable, because the hash and the tests name them.
  const keys = ADMIN_CONTENT_AREAS.map((area) => area.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, ["home", "common"]);
});

test("every selectable section maps to an editor and a preview target", () => {
  for (const section of ADMIN_PREVIEW_SECTION_KEYS) {
    const definition = adminContentSection(section);
    assert.equal(definition.key, section);
    assert.match(definition.editorTarget, /^editor-/);
    assert.match(definition.previewTarget, /^site-section-/);
    assert.ok(definition.label.length > 0, `${section} has no label`);
    assert.ok(
      adminContentSectionDescription(section).length > 0,
      `${section} has no description`,
    );

    // The editor that renders it exists, and the workspace mounts it. A section
    // that resolved to no editor would be a blank central panel.
    const editor = SECTION_EDITORS[section];
    assert.match(
      workspaceSource,
      new RegExp(`case "${section}":\\s*\\n\\s*return \\(\\s*\\n\\s*<${editor}`),
      `section "${section}" does not resolve to <${editor}>`,
    );
  }
});

test("the default selection is valid and is the first section of the first area", () => {
  const [firstArea] = ADMIN_CONTENT_AREAS;
  assert.ok(firstArea);
  assert.equal(DEFAULT_ADMIN_CONTENT_SELECTION.area, firstArea.key);
  assert.equal(DEFAULT_ADMIN_CONTENT_SELECTION.section, firstArea.sections[0]);
  assert.deepEqual(
    resolveContentSelection(DEFAULT_ADMIN_CONTENT_SELECTION),
    DEFAULT_ADMIN_CONTENT_SELECTION,
  );
});

test("every resolution lands on a pair that can render", () => {
  // A known section always wins, and brings its own area with it — including
  // when the pair it arrived in disagreed.
  for (const section of ADMIN_PREVIEW_SECTION_KEYS) {
    const resolved = resolveContentSelection({ area: "home", section });
    assert.equal(resolved.section, section);
    assert.equal(resolved.area, areaKeyForContentSection(section));
    assert.ok(
      adminContentArea(resolved.area).sections.includes(resolved.section),
      `${section} resolved outside its own area`,
    );
  }

  // A known area with no usable section opens on that area's first section.
  for (const area of ADMIN_CONTENT_AREAS) {
    assert.deepEqual(resolveContentSelection({ area: area.key }), {
      area: area.key,
      section: area.sections[0],
    });
  }

  // Anything else is the default rather than nothing.
  for (const candidate of [
    {},
    { area: null, section: null },
    { area: "nope", section: "nope" },
    { area: 7, section: ["hero"] },
    { section: "Hero" },
    { area: "home", section: "prestations" },
  ]) {
    assert.deepEqual(
      resolveContentSelection(candidate),
      DEFAULT_ADMIN_CONTENT_SELECTION,
      `${JSON.stringify(candidate)} did not fall back safely`,
    );
  }

  assert.ok(isAdminContentAreaKey("home"));
  assert.ok(!isAdminContentAreaKey("hero"));
  assert.throws(() => adminContentArea("nope" as never));
});

test("changing area keeps the current section when that section belongs to it", () => {
  const onServices = resolveContentSelection({ section: "services" });

  // Re-picking the area you are already in must not throw you back to its first
  // section, or the area buttons become a way to lose your place.
  assert.deepEqual(selectContentArea(onServices, "home"), onServices);

  const moved = selectContentArea(onServices, "common");
  assert.equal(moved.area, "common");
  assert.equal(moved.section, adminContentArea("common").sections[0]);
  assert.ok(adminContentArea("common").sections.includes(moved.section));

  // And back again lands on a valid section of the area asked for, every time.
  for (const area of ADMIN_CONTENT_AREAS) {
    for (const section of ADMIN_PREVIEW_SECTION_KEYS) {
      const next = selectContentArea(resolveContentSelection({ section }), area.key);
      assert.equal(next.area, area.key);
      assert.ok(adminContentArea(area.key).sections.includes(next.section));
    }
  }
});

test("the location hash round-trips every section and never opens on nothing", () => {
  for (const section of ADMIN_PREVIEW_SECTION_KEYS) {
    const selection = resolveContentSelection({ section });
    const hash = contentSelectionHash(selection);
    assert.equal(hash, `#${adminContentSection(section).editorTarget}`);
    assert.deepEqual(parseContentSelectionHash(hash), selection);
    // A hash handed over without its "#" is the same location.
    assert.deepEqual(parseContentSelectionHash(hash.slice(1)), selection);
  }

  for (const hash of ["", "#", "#editor-unknown", "#preview", "#hero", "nonsense"]) {
    assert.deepEqual(
      parseContentSelectionHash(hash),
      DEFAULT_ADMIN_CONTENT_SELECTION,
      `hash ${JSON.stringify(hash)} did not fall back safely`,
    );
  }
});

// ── Focused rendering ──────────────────────────────────────────────────────

test("the workspace renders one section editor, chosen by the selection", () => {
  // One mount point, fed the selection — not ten mount points with nine hidden.
  const mounts = workspaceSource.match(/<ContentSectionEditor/g) ?? [];
  assert.equal(mounts.length, 1, "the workspace mounts the section editor twice");
  assert.match(
    workspaceSource,
    /<ContentSectionEditor\s*\n\s*section=\{selection\.section\}/,
  );

  // Each specialised editor is mounted exactly once, inside the switch that maps
  // a section key to it. Twice would mean a branch renders someone else's editor.
  for (const editor of Object.values(SECTION_EDITORS)) {
    const occurrences = workspaceSource.match(new RegExp(`<${editor}\\b`, "g")) ?? [];
    assert.equal(occurrences.length, 1, `<${editor}> is mounted ${occurrences.length} times`);
  }

  // The switch is exhaustive over the section keys and has no other branch.
  const branches = [...workspaceSource.matchAll(/case "([a-z]+)":/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...branches].sort(), [...ADMIN_PREVIEW_SECTION_KEYS].sort());

  // The page that owns the draft no longer mounts any section editor itself.
  for (const editor of Object.values(SECTION_EDITORS)) {
    assert.doesNotMatch(
      editorSource,
      new RegExp(`<${editor}\\b`),
      `content-editor.tsx still renders <${editor}> alongside the workspace`,
    );
  }
});

test("the panel that is not shown is absent, not hidden", () => {
  // Hiding the other panel with CSS would leave every field of every section in
  // the tab order and in the accessibility tree — the exact problem the focused
  // editor removes, only invisible.
  assert.match(workspaceSource, /\{showsEditor && \(/);
  assert.match(workspaceSource, /\{showsPreview && \(/);
  assert.match(workspaceSource, /const showsEditor = isWideWorkspace \|\| view === "editor"/);
  assert.match(workspaceSource, /const showsPreview = isWideWorkspace \|\| view === "preview"/);
  assert.match(workspaceSource, /window\.matchMedia\(WIDE_WORKSPACE_QUERY\)/);
  // No `hidden`/`sr-only`/`display:none` dodge around the panels.
  assert.doesNotMatch(workspaceSource, /className="[^"]*\bhidden\b/);
  assert.doesNotMatch(workspaceSource, /aria-hidden="true"[\s\S]{0,80}<ContentSectionEditor/);
});

test("changing the selection is navigation and cannot write anything", () => {
  // The navigation and the workspace hold no draft, reach no API and know no
  // save or publish. Selecting a section therefore cannot save, publish, reload
  // or reset — there is nothing in either file that could.
  for (const [name, source] of [
    ["content-workspace.tsx", workspaceSource],
    ["content-section-navigation.tsx", navigationSource],
  ] as const) {
    for (const forbidden of [
      /handleSaveDraft/,
      /handlePublish/,
      /handleResetToPublished/,
      /loadServerDraft/,
      /api\./,
      /fetch\(/,
      /localStorage/,
      // Named in a comment for what it is; never called here.
      /useContentEditorController\(/,
      /useReducer/,
    ]) {
      assert.doesNotMatch(source, forbidden, `${name} reaches ${forbidden}`);
    }
  }

  // The navigation does not even see the document: it takes a selection and two
  // callbacks, so it has no way to touch content.
  assert.doesNotMatch(navigationSource, /SiteContent/);

  // The workspace never copies the document into state of its own; it reads the
  // one it is given and hands edits straight back. One draft, one source.
  assert.doesNotMatch(workspaceSource, /useState<SiteContent>/);
  assert.doesNotMatch(workspaceSource, /cloneSiteContent/);
  assert.match(workspaceSource, /onUpdate\(\(current\) => \(\{ \.\.\.current,/);
  // Section navigation replaces the hash rather than pushing history entries.
  assert.match(workspaceSource, /window\.history\.replaceState/);
  assert.doesNotMatch(workspaceSource, /history\.pushState\(/);
});

// ── Preview ────────────────────────────────────────────────────────────────

test("editor and preview share one unsaved content object", () => {
  // The same `content` prop the section editor edits is the one the preview is
  // given — no second copy, no snapshot, no saved revision in between. That is
  // what makes the preview show unsaved edits at both widths, since the mobile
  // preview mode renders this same viewport over this same object.
  assert.match(
    workspaceSource,
    /<AdminPreviewViewport\s*\n\s*content=\{content\}\s*\n\s*activeSection=\{selection\.section\}/,
  );
  const viewports = workspaceSource.match(/<AdminPreviewViewport/g) ?? [];
  assert.equal(viewports.length, 1, "there is more than one preview renderer");

  // The preview pipeline itself is untouched: still the existing viewport over
  // the existing `/admin/preview` iframe and postMessage contract.
  const viewport = readAppFile("components", "admin", "admin-preview-viewport.tsx");
  assert.match(viewport, /src="\/admin\/preview"/);
  assert.match(viewport, /createAdminPreviewContentMessage/);
  assert.doesNotMatch(workspaceSource, /<iframe/);

  // Desktop: sticky beside the editor, inside the workspace column.
  assert.match(workspaceSource, /xl:sticky xl:top-6 xl:h-\[calc\(100vh-3rem\)\]/);
});

test("small screens get an explicit preview mode over the same state", () => {
  // One switch, two modes, one selection. Switching mounts the other panel over
  // the same content object, so no edit can be lost by looking at the preview,
  // and coming back restores the section because the selection never moved.
  assert.match(workspaceSource, /aria-label="Mode de travail"/);
  assert.match(workspaceSource, /aria-pressed=\{view === option\.value\}/);
  assert.match(workspaceSource, /\{ value: "editor", label: "Éditeur" \}/);
  assert.match(workspaceSource, /\{ value: "preview", label: "Aperçu" \}/);
  // The switch is rendered only where both panels do not fit.
  assert.match(workspaceSource, /\{!isWideWorkspace && \(/);
  // The mode is a prop, so the page's own “Voir l’aperçu” reaches it too: one
  // state, not one per control.
  assert.match(workspaceSource, /view: WorkspaceView;/);
  assert.match(editorSource, /useState<WorkspaceView>\("editor"\)/);
  assert.match(editorSource, /view=\{workspaceView\}/);
  assert.match(editorSource, /onViewChange=\{setWorkspaceView\}/);
  // It is neither a drawer nor a modal: nothing to trap focus in, nothing to
  // dismiss.
  assert.doesNotMatch(workspaceSource, /role="dialog"/);
  assert.doesNotMatch(workspaceSource, /aria-modal/);
});

// ── Accessibility of the CMS navigation ────────────────────────────────────

test("the CMS navigation is a named landmark, keyboard-operable and not colour-only", () => {
  assert.match(navigationSource, /<nav\s*\n\s*aria-label="Sections du contenu"/);
  // Buttons, so every entry is a tab stop with a visible focus ring.
  assert.doesNotMatch(navigationSource, /<a\s/);
  assert.match(navigationSource, /type="button"/);
  assert.match(navigationSource, /focus:ring-2 focus:ring-sage-300/);
  // The current area and the current section are exposed semantically…
  assert.match(navigationSource, /aria-current=\{active \? "true" : undefined\}/);
  // …and marked two further ways that survive greyscale: a bar that only exists
  // when active, and a weight change.
  assert.match(navigationSource, /data-active-marker=\{active \? "true" : "false"\}/);
  assert.match(navigationSource, /font-semibold/);
  // Both lists are labelled, and long labels cannot break the layout.
  assert.match(navigationSource, /aria-labelledby="cms-area-label"/);
  assert.match(navigationSource, /aria-labelledby="cms-section-label"/);
  assert.match(navigationSource, /whitespace-nowrap/);
  assert.match(navigationSource, /overflow-x-auto/);
  // One DOM at every width: a second copy behind a media query would double the
  // tab stops and put two `aria-current` entries in the accessibility tree.
  const areaLists = navigationSource.match(/aria-labelledby="cms-area-label"/g) ?? [];
  assert.equal(areaLists.length, 1);
});

// ── ESZ-157 and ESZ-158 boundaries ─────────────────────────────────────────

test("the existing action hierarchy and safety controls survive the refactor", () => {
  // ESZ-156 recomposed the editing surface. The actions above it are ESZ-157's,
  // and must still be exactly where and what they were.
  for (const marker of [
    /Enregistrer le brouillon/,
    />\s*Publier\s*</,
    /Restaurer le contenu publié/,
    /Sauvegarder sur cet appareil/,
    /Restaurer la sauvegarde locale/,
    /Exporter une sauvegarde JSON/,
    /Importer un fichier JSON/,
    /Supprimer la sauvegarde locale/,
    /Voir l&apos;aperçu/,
    /admin-revision-conflict/,
    /Fusionner avec la version du serveur/,
    /Recharger la version du serveur/,
    /admin-freshness/,
    /Informations techniques/,
    /beforeunload/,
  ]) {
    assert.match(editorSource, marker, `the editor lost ${marker}`);
  }

  // No action was demoted into the new workspace, and none was invented there.
  assert.doesNotMatch(workspaceSource, /Enregistrer|Publier|Sauvegarde|Importer|Exporter/);

  // ESZ-158 owns the admin palette. The focused CMS reuses the accepted tokens
  // and defines none of its own.
  for (const source of [workspaceSource, navigationSource]) {
    assert.doesNotMatch(source, /:root|--warm-|@layer|style jsx/);
  }
});
