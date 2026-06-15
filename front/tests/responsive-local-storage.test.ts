import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

test("admin local draft notice explains browser-only storage and public state", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Brouillon enregistré uniquement sur cet appareil/);
  assert.match(source, /dans ce navigateur uniquement/);
  assert.match(source, /Le site public n&apos;est pas modifié/);
  assert.match(source, /exportez le fichier JSON/);
  assert.match(source, /suppression des données du navigateur/);
  assert.match(source, /navigation privée/);
});

test("admin state summary separates changes, device draft and public website", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Modifications/);
  assert.match(source, /Brouillon sur cet appareil/);
  assert.match(source, /Site public/);
  assert.match(source, /Inchangé/);
  assert.match(source, /Aucun brouillon enregistré sur cet appareil/);
  assert.doesNotMatch(source, /<span className="block font-medium text-warm-800">\s*Clé locale\s*<\/span>/);
});

test("admin action labels avoid publication wording and identify JSON backup", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /Enregistrer sur cet appareil/);
  assert.match(source, /Exporter une sauvegarde JSON/);
  assert.match(source, /Importer un fichier JSON/);
  assert.match(source, /Restaurer le contenu d&apos;origine/);
  assert.match(source, /Supprimer le brouillon de cet appareil/);
  assert.match(source, /Sauvegarde portable : fichier JSON/);
  assert.doesNotMatch(source, />\s*Publier\s*</);
});

test("import, export, reset and delete messages preserve local-only semantics", () => {
  const editorSource = readAppFile("components", "admin", "content-editor.tsx");
  const resetSource = readAppFile("lib", "admin-content-reset.ts");

  assert.match(editorSource, /Sauvegarde JSON exportée/);
  assert.match(editorSource, /Enregistrez-le sur cet appareil/);
  assert.match(editorSource, /Le site public restera inchangé/);
  assert.match(editorSource, /Brouillon supprimé de cet appareil/);
  assert.match(resetSource, /Le site public reste inchangé/);
});

test("technical storage key remains available only in secondary details", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(source, /<details/);
  assert.match(source, /Informations techniques/);
  assert.match(source, /SITE_CONTENT_DRAFT_STORAGE_KEY/);
  assert.match(source, /break-all/);
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

test("admin workspace uses a wide 60/40 editor and preview layout", () => {
  const editorSource = readAppFile("components", "admin", "content-editor.tsx");
  const layoutSource = readAppFile("admin", "(protected)", "layout.tsx");

  assert.match(editorSource, /max-w-\[1800px\]/);
  assert.match(editorSource, /grid min-w-0 gap-6/);
  assert.match(editorSource, /<div className="min-w-0 space-y-6">/);
  assert.match(editorSource, /xl:grid-cols-\[minmax\(0,3fr\)_minmax\(480px,2fr\)\]/);
  assert.match(editorSource, /xl:h-\[calc\(100vh-6\.5rem\)\]/);
  assert.match(editorSource, /Sections de l’éditeur/);
  assert.match(layoutSource, /sticky top-0/);
  assert.match(layoutSource, /max-w-\[1800px\]/);
});
