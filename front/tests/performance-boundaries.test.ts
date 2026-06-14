import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

test("unused mono font is not configured for the public layout", () => {
  const layoutSource = readFileSync(join(appRoot, "layout.tsx"), "utf8");
  const globalsSource = readFileSync(join(appRoot, "globals.css"), "utf8");

  assert.doesNotMatch(layoutSource, /Geist_Mono/);
  assert.doesNotMatch(layoutSource, /geistMono/);
  assert.doesNotMatch(globalsSource, /--font-geist-mono/);
  assert.doesNotMatch(globalsSource, /--font-mono/);
});

test("public route source remains isolated from admin-only modules", () => {
  const publicSources = [
    join(appRoot, "page.tsx"),
    join(appRoot, "components", "site-preview.tsx"),
    join(appRoot, "components", "navigation.tsx"),
    join(appRoot, "components", "mobile-nav.tsx"),
    join(appRoot, "components", "reveal.tsx"),
    join(appRoot, "components", "hero-instagram-button.tsx"),
  ]
    .map((filePath) => readFileSync(filePath, "utf8"))
    .join("\n");

  for (const forbiddenImport of [
    "content-editor",
    "admin-preview-viewport",
    "admin-draft-storage",
    "appearance-editor",
    "auth/session",
    "localStorage",
  ]) {
    assert.doesNotMatch(publicSources, new RegExp(forbiddenImport));
  }
});
