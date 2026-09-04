import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import {
  deleteDraft,
  loadDraft,
  saveDraft,
  SITE_CONTENT_DRAFT_STORAGE_KEY,
} from "../app/lib/admin-draft-storage";

/**
 * ESZ-034 — what is left of `localStorage` once the server owns the draft.
 *
 * The role it keeps is explicit backup and export recovery, and the two things it
 * must never do again are be authoritative and overwrite server state on its own.
 * The first half of this file proves the store still works as a backup; the
 * second proves the editor only ever reaches for it when told to.
 */

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

/**
 * ESZ-107 split the editor: the server flows that call the device backup live
 * in `content-editor-controller.ts`, the device backup and import/export unit
 * in `content-editor-backup.ts`. The assertions below that used to read
 * `content-editor.tsx` now read the file that owns the behaviour.
 */
const backupUnit = () => readAppFile("components", "admin", "content-editor-backup.ts");
const controllerUnit = () => readAppFile("components", "admin", "content-editor-controller.ts");

/** A `localStorage` that is a plain Map, so a test can inspect exactly what was written. */
function installFakeStorage(): Map<string, string> {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };

  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return entries;
}

function clearFakeStorage() {
  delete (globalThis as { window?: unknown }).window;
}

test("a backup round-trips through the device store under the declared key", (t) => {
  const entries = installFakeStorage();
  t.after(clearFakeStorage);

  const written = saveDraft(defaultSiteContent);
  assert.equal(written.ok, true);
  if (!written.ok) return;

  assert.deepEqual([...entries.keys()], [SITE_CONTENT_DRAFT_STORAGE_KEY]);

  const read = loadDraft();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.draft?.content, defaultSiteContent);
  assert.equal(read.draft?.savedAt, written.draft.savedAt);
});

test("the backup carries content only, never a session or a CSRF token", (t) => {
  const entries = installFakeStorage();
  t.after(clearFakeStorage);

  saveDraft(defaultSiteContent);
  const raw = entries.get(SITE_CONTENT_DRAFT_STORAGE_KEY) ?? "";
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // A CSRF token outlives the tab if it is written here, and it is bound to a
  // session that will have rotated by the time anything reads it back.
  assert.deepEqual(Object.keys(parsed).sort(), [
    "content",
    "savedAt",
    "schemaVersion",
  ]);
  assert.doesNotMatch(raw, /csrf/i);
  assert.doesNotMatch(raw, /session/i);
});

test("an empty device store is not an error and restores nothing", (t) => {
  installFakeStorage();
  t.after(clearFakeStorage);

  const read = loadDraft();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  // "No backup" must be distinguishable from "a backup that failed to parse":
  // one is the normal case on a new machine, the other needs the admin to act.
  assert.equal(read.draft, null);
});

test("a corrupted backup is reported as deletable and never partially applied", (t) => {
  const entries = installFakeStorage();
  t.after(clearFakeStorage);

  entries.set(SITE_CONTENT_DRAFT_STORAGE_KEY, "{ not json");
  const read = loadDraft();

  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.canDelete, true);
  assert.equal(read.error.code, "malformed-json");
});

test("deleting the backup leaves nothing behind on the device", (t) => {
  const entries = installFakeStorage();
  t.after(clearFakeStorage);

  saveDraft(defaultSiteContent);
  assert.equal(deleteDraft().ok, true);
  assert.equal(entries.size, 0);
});

test("the editor bootstraps from the server draft, never from the device", () => {
  const controller = controllerUnit();
  const backup = backupUnit();

  // The bootstrap effect reads the API (the controller's `loadServerDraft`).
  // The device is read in a *separate* report-only step whose only job is to
  // say that a backup exists — it never feeds the editor document.
  assert.match(controller, /await loadServerDraft\(\)/);
  assert.match(controller, /api\.readDraft\(\)/);
  assert.match(
    backup,
    /const backup = loadDraft\(\);\s*\n\s*setBackupSavedAt\(backup\.ok \? \(backup\.draft\?\.savedAt \?\? null\) : null\);/,
  );
  // The bootstrap read never replaces the working document: only the server
  // draft and an explicit restore do. The controller has no device read at
  // all, and the backup unit's report-only reader never reaches `replace`.
  assert.doesNotMatch(controller, /loadDraft\(\)/);
  assert.doesNotMatch(
    backup,
    /const backup = loadDraft\(\);[\s\S]{0,250}replace\(/,
  );

  // Restoring a backup into the editor happens in a handler, behind a
  // confirmation, and still requires an explicit save to reach the server.
  assert.match(backup, /function handleRestoreLocalBackup\(/);
  assert.match(backup, /restoreBackupConfirm/);
  assert.match(backup, /window\.confirm\(BACKUP_MESSAGES\.restoreBackupConfirm\)/);
});

test("a refused write puts the only copy of unsaved work on the device first", () => {
  const controller = controllerUnit();
  const backup = backupUnit();

  // The 409 branch of the save hands over to the reconciliation, whose very
  // first step — before any network call — is the device backup. At that moment
  // the content on screen is the only copy that exists anywhere.
  assert.match(
    controller,
    /if \(result\.failure\.kind === "conflict"\) \{\s*\n\s*await reconcileAfterSaveConflict/,
  );
  const reconciliation = readAppFile("lib", "admin-draft-reconciliation.ts");
  assert.match(
    reconciliation,
    /const backupWritten = backup\(local\);[\s\S]{0,200}await ports\.readDraft\(\)/,
  );
  // The reconciliation hands the backup unit the document it must write.
  assert.match(controller, /backup: \(content\) => writeLocalBackup\(content\),/);
  // Reset replaces what is on screen with the published document, so anything
  // unsaved is written out before that happens. The controller reaches the
  // backup unit with the current working document explicitly.
  assert.match(controller, /if \(isDirty\) writeLocalBackup\(contentRef\.current\);/);
  // So does taking the server's draft during a conflict.
  assert.match(
    controller,
    /handleReloadServerDraft[\s\S]{0,400}writeLocalBackup\(contentRef\.current\);/,
  );
  // And so does an expiry: signing out unmounts the editor, so the honest
  // handling of a dead session would otherwise be the data-loss path.
  assert.match(
    controller,
    /if \(isDirtyRef\.current\) writeLocalBackup\(contentRef\.current\);\s*\n\s*markExpired\(\);/,
  );

  // The backup unit itself is what performs the device write.
  assert.match(backup, /const writeLocalBackup = useCallback\(/);
});

test("no admin module writes a session or CSRF secret to the device", () => {
  const sources = [
    readAppFile("components", "admin", "content-editor.tsx"),
    readAppFile("components", "admin", "admin-session-provider.tsx"),
    readAppFile("components", "admin", "admin-login-form.tsx"),
    readAppFile("lib", "admin-api.ts"),
    readAppFile("lib", "admin-session.ts"),
    readAppFile("lib", "admin-server-draft.ts"),
    // ESZ-107: the extracted editor units are admin modules too.
    backupUnit(),
    controllerUnit(),
    readAppFile("components", "admin", "content-editor-sections.tsx"),
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /localStorage\.setItem/);
    assert.doesNotMatch(source, /sessionStorage/);
    assert.doesNotMatch(source, /document\.cookie/);
    // A token in a console line is a token in whatever collects console lines.
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^)]*csrf/i);
  }
});
