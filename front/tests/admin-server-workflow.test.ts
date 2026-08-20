import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ADMIN_CONTENT_DRAFT_PATH,
  ADMIN_CONTENT_PUBLISH_PATH,
  ADMIN_CONTENT_RESET_PATH,
  AUTH_LOGIN_PATH,
  AUTH_SESSION_PATH,
} from "@eszter/contracts";

/**
 * ESZ-034/035 — the wiring, and what ESZ-035 says must survive it.
 *
 * These are source assertions rather than rendered ones: the frontend suite runs
 * under `node:test` with no DOM, so what can be proven here is the shape of the
 * wiring. The behaviour behind it is covered by the unit suites over
 * `admin-api`, `admin-session` and `admin-server-draft`, and the server side by
 * the Package 3.1 PHP gates.
 */

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

test("no admin route spells an API path instead of naming it from the contract", () => {
  const sources = [
    readAppFile("lib", "admin-api.ts"),
    readAppFile("components", "admin", "content-editor.tsx"),
    readAppFile("components", "admin", "admin-login-form.tsx"),
    readAppFile("components", "admin", "admin-session-provider.tsx"),
  ];

  // The paths live in `@eszter/contracts`, which PHP reads the same values out
  // of. A literal here would make a route rename a silent production break
  // instead of a failed gate.
  const api = sources[0] ?? "";
  for (const symbol of [
    "ADMIN_CONTENT_DRAFT_PATH",
    "ADMIN_CONTENT_PUBLISH_PATH",
    "ADMIN_CONTENT_RESET_PATH",
    "AUTH_LOGIN_PATH",
    "AUTH_LOGOUT_PATH",
    "AUTH_SESSION_PATH",
    "CSRF_HEADER",
    "CONTENT_REVISION_HEADER",
  ]) {
    assert.match(api, new RegExp(symbol));
  }

  for (const source of sources.slice(1)) {
    for (const path of [
      ADMIN_CONTENT_DRAFT_PATH,
      ADMIN_CONTENT_PUBLISH_PATH,
      ADMIN_CONTENT_RESET_PATH,
      AUTH_LOGIN_PATH,
      AUTH_SESSION_PATH,
    ]) {
      assert.doesNotMatch(source, new RegExp(`"${path}"`));
    }
  }
});

test("every privileged write states the loaded revision as its precondition", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  assert.match(
    source,
    /api\.saveDraft\(\s*\n?\s*\{ content: contentRef\.current, expectedRevision: draft\.revision \}/,
  );
  assert.match(source, /api\.publish\(\s*\n?\s*\{ expectedRevision: draft\.revision \}/);
  assert.match(source, /api\.resetDraft\(\s*\n?\s*\{ expectedRevision: draft\.revision \}/);

  // `canWrite` refuses a null revision, so no handler can reach the API without
  // a head to state — an absent `expectedRevision` is a 400, never an
  // unconditional write.
  const guards = source.match(/if \(!canWrite\(draft\) \|\| draft\.revision === null\) return;/g);
  assert.equal(guards?.length, 3);
});

test("publishing is explicit, confirmed, and refuses to run on unsaved text", () => {
  const source = readAppFile("components", "admin", "content-editor.tsx");

  // Publish takes what is *stored*. Offering it on a dirty editor would publish
  // something other than what the admin is looking at.
  assert.match(
    source,
    /if \(isDirty\) \{[\s\S]{0,200}unsavedBeforePublish[\s\S]{0,80}return;/,
  );
  assert.match(source, /window\.confirm\(EDITOR_MESSAGES\.publishConfirm\)/);
  assert.match(source, /publishConfirm:[\s\S]{0,200}site public affichera/);

  // Saving is not publishing, and the copy has to keep saying so.
  const messages = readAppFile("lib", "admin-server-draft.ts");
  assert.match(messages, /saved:[\s\S]{0,160}Le site public reste inchangé/);
});

test("reset delegates to the server route rather than rebuilding content locally", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const api = readAppFile("lib", "admin-api.ts");

  assert.match(editor, /api\.resetDraft/);
  assert.match(editor, /Restaurer le contenu publié/);
  // `adminContent.reset.sources` is a closed enum of one. The client names it;
  // it does not reconstruct the published document and save it as a draft, which
  // would be a different operation with a different revision outcome.
  assert.match(api, /const RESET_SOURCE = "published" as const;/);
  assert.match(api, /source: RESET_SOURCE/);
});

test("no 409 path anywhere can write against a head whose content was not read", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const state = readAppFile("lib", "admin-server-draft.ts");
  const reconciliation = readAppFile("lib", "admin-draft-reconciliation.ts");

  // The removed defect, named so a reintroduction is loud: an action that took
  // the head off the 409 response and a button that offered it as "keep mine".
  for (const source of [editor, state]) {
    assert.doesNotMatch(source, /conflict-rebase/);
    assert.doesNotMatch(source, /conflictRebased/);
  }
  assert.doesNotMatch(editor, /Conserver mes modifications/);
  assert.doesNotMatch(editor, /keepLocalConfirm/);

  // The only revision the client sends is one that arrived with its content.
  assert.match(
    reconciliation,
    /expectedRevision: server\.revision/,
  );
  // And the header value is carried under a name that says it is not one.
  assert.match(state, /reportedServerRevision/);
  assert.doesNotMatch(state, /revision: state\.reportedServerRevision/);
});

test("a refused save reconciles against fetched content, backing up first", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const reconciliation = readAppFile("lib", "admin-draft-reconciliation.ts");

  assert.match(
    editor,
    /if \(result\.failure\.kind === "conflict"\) \{\s*\n\s*await reconcileAfterSaveConflict/,
  );
  // Order matters and is asserted as order: the backup precedes the fetch, which
  // precedes any merge, which precedes the single save.
  const backupAt = reconciliation.indexOf("const backupWritten = backup(local);");
  const readAt = reconciliation.indexOf("await ports.readDraft()");
  const mergeAt = reconciliation.indexOf("mergeSiteContent(base, local, server.content)");
  const saveAt = reconciliation.indexOf("await ports.saveDraft(");
  assert.ok(backupAt > -1 && readAt > backupAt && mergeAt > readAt && saveAt > mergeAt);

  // One attempt. No loop, no recursion, no second call site.
  assert.equal(reconciliation.match(/ports\.saveDraft\(/g)?.length, 1);
  assert.doesNotMatch(reconciliation, /while \(|for \(/);
});

test("publish and reset answer a 409 by re-reading, never by forcing", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const reconciliation = readAppFile("lib", "admin-draft-reconciliation.ts");

  for (const operation of ["publishing", "resetting"]) {
    assert.match(
      editor,
      new RegExp(`await refreshAfterRefusedAction\\("${operation}"`),
    );
  }
  // The refresh surface has no way to re-attempt the operation it is recovering
  // from: it can read, and that is all it is given.
  assert.doesNotMatch(reconciliation, /ports\.publish|ports\.resetDraft/);
  assert.match(editor, /contentAdopted = !isDirtyRef\.current/);
});

test("a 401 anywhere flips the admin area to signed out, a 403 only refreshes", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const provider = readAppFile("components", "admin", "admin-session-provider.tsx");

  assert.match(
    editor,
    /if \(failure\.kind === "unauthenticated"\) \{[\s\S]{0,600}markExpired\(\);\s*\n\s*return;/,
  );
  assert.match(
    editor,
    /if \(failure\.kind === "forbidden"\) \{\s*\n\s*void refreshSession\(\);/,
  );
  assert.match(provider, /markExpired/);
  assert.match(provider, /Connexion requise/);
});

test("/admin/login wires the real CSRF-bound form into the protected workflow", () => {
  const page = readAppFile("admin", "login", "page.tsx");
  const source = readAppFile("components", "admin", "admin-login-form.tsx");

  // The exported route renders the client form rather than a placeholder.
  assert.match(page, /import \{ AdminLoginForm \}/);
  assert.match(page, /return <AdminLoginForm \/>;/);
  assert.match(source, /<form onSubmit=\{handleSubmit\}/);

  // Login itself is CSRF-protected. Mounting obtains the anonymous session and
  // its token; submit passes that token to the PHP login transport.
  assert.match(source, /useEffect\(\(\) => \{[\s\S]{0,120}void readSession\(\)/);
  assert.match(source, /api\.login\([\s\S]{0,120}current\.csrfToken/);
  assert.match(source, /autoComplete="current-password"/);
  // Cleared before navigating: nothing keeps the password in a React tree that a
  // devtools inspection or an error overlay could surface.
  assert.match(
    source,
    /if \(result\.ok\) \{[\s\S]{0,300}setPassword\(""\);[\s\S]{0,160}window\.location\.assign\(destination\(\)\)/,
  );
  assert.doesNotMatch(source, /localStorage/);
});

test("ESZ-035: the preview still mirrors the working draft, unpublished", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");
  const viewport = readAppFile("components", "admin", "admin-preview-viewport.tsx");

  // The preview is fed the in-memory content, so it shows unsaved edits — which
  // is the point of a preview and is unrelated to publication.
  assert.match(
    editor,
    /<AdminPreviewViewport\s*\n\s*content=\{content\}\s*\n\s*activeSection=\{activeSection\}/,
  );
  assert.match(viewport, /postMessage/);
  assert.doesNotMatch(viewport, /publish/i);
});

test("ESZ-035: navigation, sections, appearance and validation survive the rewiring", () => {
  const editor = readAppFile("components", "admin", "content-editor.tsx");

  for (const marker of [
    /ADMIN_PREVIEW_SECTIONS\.map/,
    /handleSectionNavigation/,
    /IntersectionObserver/,
    /<AppearanceEditor/,
    /<NavigationEditor/,
    /<HeroEditor/,
    /<ReassuranceEditor/,
    /<ServicesEditor/,
    /<ProcessEditor/,
    /<GalleryEditor/,
    /<AboutEditor/,
    /<ContactEditor/,
    /<FooterEditor/,
    /beforeunload/,
    /handleExportDraft/,
    /handleImportDraft/,
  ]) {
    assert.match(editor, marker);
  }
});

test("ESZ-035: nothing server-only was reintroduced into the export", () => {
  const sources = [
    readAppFile("admin", "login", "page.tsx"),
    readAppFile("admin", "(protected)", "layout.tsx"),
    readAppFile("admin", "(protected)", "page.tsx"),
    readAppFile("components", "admin", "admin-session-provider.tsx"),
    readAppFile("components", "admin", "admin-login-form.tsx"),
    readAppFile("lib", "admin-api.ts"),
  ];

  for (const source of sources) {
    // `output: "export"` turns each of these into a build error rather than a
    // runtime surprise, but a failing build is a worse way to learn it than a
    // failing test that names the rule.
    assert.doesNotMatch(source, /next\/headers/);
    assert.doesNotMatch(source, /"server-only"/);
    assert.doesNotMatch(source, /export const dynamic/);
    assert.doesNotMatch(source, /export const revalidate/);
    assert.doesNotMatch(source, /\bmiddleware\b/);
  }

  // The two client entries must say so; a server component cannot hold a session.
  assert.match(sources[3] ?? "", /^"use client";/);
  assert.match(sources[4] ?? "", /^"use client";/);
  // The pages that carry `robots: none` stay server components so they can.
  assert.match(sources[0] ?? "", /export const metadata/);
  assert.match(sources[1] ?? "", /export const metadata/);
});
