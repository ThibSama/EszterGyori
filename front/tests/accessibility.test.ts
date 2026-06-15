import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

test("public page exposes a skip link and one main landmark", () => {
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(sitePreviewSource, /href="#main-content"/);
  assert.match(sitePreviewSource, /<main\s+id="main-content"\s+tabIndex=\{-1\}/);
  assert.equal((sitePreviewSource.match(/<main\s/g) ?? []).length, 1);
});

test("public heading hierarchy includes a hidden reassurance h2 before h3 cards", () => {
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(sitePreviewSource, /<h1\b/);
  assert.match(sitePreviewSource, /<h2 className="sr-only">Pourquoi choisir Eszter Gyori<\/h2>/);
});

test("navigation has accessible labels and the closed mobile menu is not rendered", () => {
  const navigationSource = readFileSync(
    join(appRoot, "components", "navigation.tsx"),
    "utf8",
  );
  const mobileNavSource = readFileSync(
    join(appRoot, "components", "mobile-nav.tsx"),
    "utf8",
  );

  assert.match(navigationSource, /aria-label="Navigation principale"/);
  assert.match(navigationSource, /aria-label="Retour au début de la page"/);
  assert.match(mobileNavSource, /aria-controls=\{menuId\}/);
  assert.match(mobileNavSource, /aria-expanded=\{open\}/);
  assert.match(mobileNavSource, /event\.key !== "Escape"/);
  assert.match(mobileNavSource, /buttonRef\.current\?\.focus\(\)/);
  assert.match(mobileNavSource, /open &&\s*createPortal/s);
  assert.match(mobileNavSource, /aria-hidden="true"/);
  assert.doesNotMatch(mobileNavSource, /pointer-events-none/);
});

test("focus visibility and reduced motion are globally covered", () => {
  const globalsSource = readFileSync(join(appRoot, "globals.css"), "utf8");
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(globalsSource, /\.skip-link/);
  assert.match(globalsSource, /:focus-visible/);
  assert.match(globalsSource, /outline: 3px solid var\(--site-primary, #63726C\) !important/);
  assert.match(globalsSource, /prefers-reduced-motion: reduce/);
  assert.match(globalsSource, /scroll-behavior: auto !important/);
  assert.match(sitePreviewSource, /<footer[\s\S]*text-warm-600/);
});

test("admin forms and editor messages expose live feedback", () => {
  const loginSource = readFileSync(join(appRoot, "admin", "login", "page.tsx"), "utf8");
  const contentEditorSource = readFileSync(
    join(appRoot, "components", "admin", "content-editor.tsx"),
    "utf8",
  );

  assert.match(loginSource, /role="alert"/);
  assert.match(contentEditorSource, /role="status"/);
  assert.match(contentEditorSource, /aria-live="polite"/);
  assert.match(contentEditorSource, /role="alert"/);
});
