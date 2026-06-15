import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createAdminPreviewNavigationMessage,
  parseAdminPreviewNavigationMessage,
} from "../app/lib/admin-preview-messaging";
import {
  ADMIN_PREVIEW_SECTIONS,
} from "../app/lib/admin-preview-sections";

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

test("admin preview section mapping covers editor and public targets", () => {
  assert.deepEqual(
    ADMIN_PREVIEW_SECTIONS.map((section) => section.key),
    [
      "appearance",
      "navigation",
      "hero",
      "reassurance",
      "services",
      "process",
      "gallery",
      "about",
      "contact",
      "footer",
    ],
  );

  for (const section of ADMIN_PREVIEW_SECTIONS) {
    assert.match(section.editorTarget, /^editor-/);
    assert.match(section.previewTarget, /^site-section-/);
    assert.ok(section.fallback.length > 0);
  }
});

test("admin preview navigation messages accept known sections only", () => {
  const source = {};
  const event = {
    data: createAdminPreviewNavigationMessage("gallery", "smooth"),
    origin: "https://eszter.local",
    source,
  };

  assert.deepEqual(
    parseAdminPreviewNavigationMessage(
      event,
      "https://eszter.local",
      source,
    ),
    { status: "accepted", section: "gallery", behavior: "smooth" },
  );

  assert.deepEqual(
    parseAdminPreviewNavigationMessage(
      {
        data: {
          type: "ESZTER_ADMIN_PREVIEW_NAVIGATE",
          section: "unknown",
          behavior: "smooth",
        },
        origin: "https://eszter.local",
        source,
      },
      "https://eszter.local",
      source,
    ),
    { status: "rejected" },
  );

  assert.deepEqual(
    parseAdminPreviewNavigationMessage(
      {
        data: createAdminPreviewNavigationMessage("services", "smooth"),
        origin: "https://evil.example",
        source,
      },
      "https://eszter.local",
      source,
    ),
    { status: "rejected" },
  );
});

test("admin editor sends the active section to the noninteractive preview", () => {
  const editorSource = readAppFile("components", "admin", "content-editor.tsx");
  const previewSource = readAppFile(
    "components",
    "admin",
    "admin-preview-viewport.tsx",
  );

  assert.match(editorSource, /useState<AdminPreviewSectionKey>\("hero"\)/);
  assert.match(editorSource, /IntersectionObserver/);
  assert.match(editorSource, /aria-current=/);
  assert.match(editorSource, /activeSection=\{activeSection\}/);
  assert.match(previewSource, /createAdminPreviewNavigationMessage/);
  assert.match(previewSource, /sendNavigation\("auto"\)/);
  assert.match(previewSource, /sendNavigation\("smooth"\)/);
  assert.match(previewSource, /pointer-events-none/);
  assert.match(previewSource, /tabIndex=\{-1\}/);
});

test("public sections expose approved preview targets", () => {
  const siteSource = readAppFile("components", "site-preview.tsx");
  const gallerySource = readAppFile("components", "site-gallery-section.tsx");

  const combinedSource = `${siteSource}\n${gallerySource}`;
  const previewTargets = new Set(
    ADMIN_PREVIEW_SECTIONS.map((section) => section.previewTarget),
  );

  for (const target of previewTargets) {
    assert.match(
      combinedSource,
      new RegExp(`data-preview-section="${target}"`),
    );
  }
});

test("preview client scrolls by section key and respects reduced motion", () => {
  const source = readAppFile("admin", "preview", "admin-preview-client.tsx");

  assert.match(source, /parseAdminPreviewNavigationMessage/);
  assert.match(source, /ADMIN_PREVIEW_SECTION_BY_KEY/);
  assert.match(source, /querySelector<HTMLElement>/);
  assert.match(source, /document\.documentElement\.scrollHeight/);
  assert.match(source, /window\.innerHeight/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /window\.scrollTo/);
  assert.doesNotMatch(source, /eval\(/);
});
