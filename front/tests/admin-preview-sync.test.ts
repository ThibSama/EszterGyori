import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createAdminPreviewNavigationMessage,
  createAdminPreviewReadyMessage,
  parseAdminPreviewNavigationMessage,
  parseAdminPreviewReadyMessage,
} from "../app/lib/admin-preview-messaging";
import {
  ADMIN_PREVIEW_SECTIONS,
} from "../app/lib/admin-preview-sections";
import { DEFAULT_ADMIN_CONTENT_SELECTION } from "../app/lib/admin-content-navigation";

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
  // ESZ-156: the active section used to be inferred from the scroll position of a
  // page that rendered every editor, which is why this asserted an
  // `IntersectionObserver`. The editor now renders one section at a time, so the
  // active section *is* the selection — the same fact, established by choice
  // rather than by scrolling — and it is still what the preview is told.
  const workspaceSource = readAppFile("components", "admin", "content-workspace.tsx");
  const navigationSource = readAppFile(
    "components",
    "admin",
    "content-section-navigation.tsx",
  );
  const previewSource = readAppFile(
    "components",
    "admin",
    "admin-preview-viewport.tsx",
  );

  assert.deepEqual(DEFAULT_ADMIN_CONTENT_SELECTION, {
    area: "home",
    section: "hero",
  });
  assert.match(workspaceSource, /DEFAULT_ADMIN_CONTENT_SELECTION/);
  assert.doesNotMatch(workspaceSource, /IntersectionObserver/);
  assert.match(navigationSource, /aria-current=/);
  assert.match(workspaceSource, /activeSection=\{selection\.section\}/);
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

test("the preview announces it is listening, and only from its own frame", () => {
  // ESZ-156: the first content message used to be posted into an iframe that may
  // not have mounted its listener yet, and a dropped one was never retried. The
  // preview now says when it is ready and the editor answers with the document —
  // which is what makes the on-demand preview mode on a phone work at all.
  const previewWindow = {};
  const event = {
    data: createAdminPreviewReadyMessage(),
    origin: "https://eszter.local",
    source: previewWindow,
  };

  assert.deepEqual(
    parseAdminPreviewReadyMessage(event, "https://eszter.local", previewWindow),
    { status: "accepted" },
  );

  // Another frame cannot make the editor answer with content…
  assert.deepEqual(
    parseAdminPreviewReadyMessage(event, "https://eszter.local", {}),
    { status: "rejected" },
  );
  // …nor can another origin.
  assert.deepEqual(
    parseAdminPreviewReadyMessage(
      { ...event, origin: "https://evil.example" },
      "https://eszter.local",
      previewWindow,
    ),
    { status: "rejected" },
  );
  // Anything else on the channel is simply not this message.
  for (const data of [null, "ready", { type: "SOMETHING_ELSE" }]) {
    assert.deepEqual(
      parseAdminPreviewReadyMessage(
        { data, origin: "https://eszter.local", source: previewWindow },
        "https://eszter.local",
        previewWindow,
      ),
      { status: "ignored" },
    );
  }

  // The ping carries no content: it cannot be a way into the preview.
  assert.deepEqual(Object.keys(createAdminPreviewReadyMessage()), ["type"]);

  const clientSource = readAppFile("admin", "preview", "admin-preview-client.tsx");
  const viewportSource = readAppFile(
    "components",
    "admin",
    "admin-preview-viewport.tsx",
  );
  // Announced after the listener is attached, never when opened standalone.
  assert.match(
    clientSource,
    /window\.addEventListener\("message", handleMessage\);[\s\S]{0,400}window\.parent\.postMessage\(\s*\n?\s*createAdminPreviewReadyMessage\(\)/,
  );
  assert.match(clientSource, /if \(window\.parent !== window\)/);
  // Answered with the document, from the frame this viewport owns.
  assert.match(viewportSource, /parseAdminPreviewReadyMessage\(/);
  assert.match(viewportSource, /iframeRef\.current\?\.contentWindow,/);
});
