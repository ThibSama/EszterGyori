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
  const loginFormSource = readFileSync(
    join(appRoot, "components", "admin", "admin-login-form.tsx"),
    "utf8",
  );
  const sessionSource = readFileSync(
    join(appRoot, "components", "admin", "admin-session-provider.tsx"),
    "utf8",
  );
  const contentEditorSource = readFileSync(
    join(appRoot, "components", "admin", "content-editor.tsx"),
    "utf8",
  );

  // ESZ-020 replaced the login form with a static notice, and this test asserted
  // the absence of a form because there was nothing in the export that could
  // check a credential — `role="alert"` would have been announcing nothing.
  //
  // ESZ-034 restores the form against `/api/auth/login`, so the assertion the old
  // comment promised comes back with it: a rejected sign-in interrupts, because
  // an admin who cannot see the field is otherwise left waiting on a form that
  // silently did nothing. Progress stays polite.
  assert.match(loginFormSource, /<form/);
  assert.match(loginFormSource, /type="password"/);
  assert.match(loginFormSource, /role="alert"/);
  assert.match(loginFormSource, /aria-live="polite"/);

  // The session bootstrap replaces the whole screen while it resolves, so its
  // notice has to be announced rather than silently swapped in.
  assert.match(sessionSource, /role="status"/);
  assert.match(sessionSource, /aria-live="polite"/);

  assert.match(contentEditorSource, /role="status"/);
  assert.match(contentEditorSource, /aria-live="polite"/);
  assert.match(contentEditorSource, /role="alert"/);
});
