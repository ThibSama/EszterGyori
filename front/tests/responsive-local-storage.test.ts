import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

test("admin notice explains server-backed drafts and the separate publish step", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Brouillon enregistré sur le serveur/);
  assert.match(source, /conservé pour\s*\n?\s*tous les appareils/);
  assert.match(source, /Publier est une action distincte/);
  assert.match(source, /secours/);
  // The pre-ESZ-034 promise that the browser was the only place a draft lived is
  // no longer true, and leaving the sentence behind would be the worst outcome of
  // this package: an admin trusting a warning that no longer describes anything.
  assert.doesNotMatch(source, /Brouillon enregistré uniquement sur cet appareil/);
  assert.doesNotMatch(source, /les brouillons sont conservés dans ce navigateur uniquement/);
});

test("admin state summary separates unsaved, server draft, public and local backup", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Modifications/);
  assert.match(source, /Brouillon serveur/);
  assert.match(source, /Site public/);
  assert.match(source, /Sauvegarde locale/);
  assert.match(source, /getServerDraftState\(draft\.revision, draft\.updatedAt\)/);
  assert.match(source, /getPublishedState\(draft\.publishedRevision, draft\.publishedAt\)/);
  assert.match(source, /ADMIN_DRAFT_FRESHNESS_LABELS\[freshness\]/);
  // "Site public: Inchangé" was a constant because nothing could change it. It is
  // now a read of the published revision, and a hard-coded answer would be a lie.
  assert.doesNotMatch(source, /<span className="block font-medium text-warm-800">\s*Clé locale\s*<\/span>/);
});

test("admin action labels name the server draft, publication and the local backup apart", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Enregistrer le brouillon/);
  assert.match(source, />\s*Publier\s*</);
  assert.match(source, /Restaurer le contenu publié/);
  assert.match(source, /Sauvegarder sur cet appareil/);
  assert.match(source, /Restaurer la sauvegarde locale/);
  assert.match(source, /Exporter une sauvegarde JSON/);
  assert.match(source, /Importer un fichier JSON/);
  assert.match(source, /Supprimer la sauvegarde locale/);
  assert.match(source, /Sauvegarde portable : fichier JSON/);
});

test("import, export and backup messages keep the server draft authoritative", () => {
  // ESZ-107: the backup/import/export unit owns this copy now; the header only
  // renders whatever status the reducer carries.
  const source = readAppFile("components", "admin", "content-editor-backup.ts");

  assert.match(source, /Sauvegarde JSON exportée/);
  assert.match(source, /Enregistrez-le sur le serveur pour le conserver/);
  assert.match(source, /le brouillon du serveur fait foi/);
  assert.match(source, /Le brouillon du serveur ne sera pas modifié tant que vous n’enregistrez pas/);
  assert.match(source, /Sauvegarde locale supprimée de cet appareil/);
});

test("technical details name the storage key and deny storing session secrets", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /<details/);
  assert.match(source, /Informations techniques/);
  assert.match(source, /SITE_CONTENT_DRAFT_STORAGE_KEY/);
  assert.match(source, /break-all/);
  assert.match(source, /Aucun identifiant de session ni jeton de sécurité/);
});

test("admin preview exposes phone, tablet and desktop modes", () => {
  const source = readAppFile("components", "admin", "admin-preview-viewport.tsx");

  assert.match(source, /type PreviewMode = "phone" \| "tablet" \| "desktop"/);
  assert.match(source, /phone: \{ label: "Téléphone", width: 390, height: 844 \}/);
  assert.match(source, /tablet: \{ label: "Tablette", width: 768, height: 1024 \}/);
  assert.match(source, /desktop: \{ label: "Ordinateur", width: 1440, height: 900 \}/);
  assert.match(source, /availableSize\.width/);
  assert.match(source, /availableSize\.height/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{mode === nextMode\}/);
  assert.match(source, /grid w-full max-w-sm grid-cols-3/);
  assert.match(source, /whitespace-nowrap/);
  assert.match(source, /title="Aperçu en direct du site"/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /scrolling="no"/);
  assert.match(source, /pointer-events-none/);
  assert.doesNotMatch(source, /flex-wrap/);
  assert.doesNotMatch(source, /0\.25/);
});

test("responsive admin primitives wrap technical ids and color values", () => {
  const source = readAppFile("components", "admin", "editor-fields.tsx");

  assert.match(source, /break-all rounded-lg/);
  assert.match(source, /break-all rounded-md/);
});

test("public anchor targets keep space below the fixed navbar", () => {
  const globalsSource = readAppFile("globals.css");

  assert.match(globalsSource, /scroll-margin-top: 6rem/);
  assert.match(globalsSource, /#prestations/);
  assert.match(globalsSource, /#parcours/);
  assert.match(globalsSource, /#realisations/);
  assert.match(globalsSource, /#a-propos/);
  assert.match(globalsSource, /#contact/);
});

test("admin workspace uses a navigation, editor and preview layout", () => {
  // ESZ-156: the workspace gained a third column. The editor/preview split it
  // had is still there and still sticky; what changed is that the CMS's own
  // navigation now has a column of its own from `lg` up, and that the editor
  // column holds one section rather than all ten.
  const editorSource = readAppFile("components", "admin", "content-editor.tsx");
  const workspaceSource = readAppFile("components", "admin", "content-workspace.tsx");
  const navigationSource = readAppFile(
    "components",
    "admin",
    "content-section-navigation.tsx",
  );
  const shellSource = readAppFile("components", "admin", "admin-shell.tsx");

  assert.match(editorSource, /max-w-\[1800px\]/);
  assert.match(workspaceSource, /grid min-w-0 gap-6/);
  // Navigation beside the editor at `lg`, the preview joining them at `xl`.
  assert.match(
    workspaceSource,
    /lg:grid-cols-\[minmax\(0,15rem\)_minmax\(0,1fr\)\]/,
  );
  assert.match(
    workspaceSource,
    /xl:grid-cols-\[minmax\(0,15rem\)_minmax\(0,3fr\)_minmax\(420px,2fr\)\]/,
  );
  // The chrome is a sidebar from `lg` up (ESZ-154), so it no longer eats any
  // vertical space here: the sticky preview column only has to clear the
  // workspace's own `py-6`.
  assert.match(workspaceSource, /xl:sticky xl:top-6 xl:h-\[calc\(100vh-3rem\)\]/);
  // The CMS navigation is a landmark with a name of its own, distinct from the
  // shell's — an operator tabbing through the page can tell the two apart.
  assert.match(navigationSource, /aria-label="Sections du contenu"/);
  assert.match(navigationSource, /lg:sticky lg:top-6/);
  // The chrome moved out of the layout and into the shell, where it sticks as a
  // sidebar rather than as a bar across the top of the workspace.
  assert.match(shellSource, /lg:sticky lg:top-0/);
});
