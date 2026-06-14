import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

test("navigation tint is applied only to the rounded glass surface", () => {
  const navigationSource = readFileSync(
    join(appRoot, "components", "navigation.tsx"),
    "utf8",
  );
  const globalsSource = readFileSync(join(appRoot, "globals.css"), "utf8");

  assert.doesNotMatch(
    navigationSource,
    /<nav[^>]*site-section-navigation/,
    "the fixed navigation wrapper must remain visually transparent",
  );
  assert.match(
    navigationSource,
    /site-navigation-glass/,
    "the rounded navigation surface must own the glass styling hook",
  );
  assert.match(
    globalsSource,
    /\.site-preview \.site-navigation-glass\s*\{/,
    "navigation glass styling must be scoped to SitePreview",
  );
  assert.match(
    globalsSource,
    /--site-section-navigation/,
    "the configurable navigation tint variable must remain in use",
  );
});

test("other section tint selectors remain present", () => {
  const globalsSource = readFileSync(join(appRoot, "globals.css"), "utf8");

  for (const sectionClass of [
    "site-section-hero",
    "site-section-reassurance",
    "site-section-services",
    "site-section-process",
    "site-section-gallery",
    "site-section-about",
    "site-section-contact",
    "site-section-footer",
  ]) {
    assert.match(globalsSource, new RegExp(`\\.${sectionClass}`));
  }
});
