import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * ESZ-157: the ranking of the CMS actions.
 *
 * The package moved controls and changed how loud they look; it changed no
 * handler, no gate and no server semantics. These tests pin both halves of that
 * claim — what the primary area must hold, what must stay out of it, and that
 * every control still calls the accepted callback behind the accepted condition.
 */

const appRoot = join(process.cwd(), "app");

function readAppFile(...segments: string[]): string {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const editorSource = readAppFile("components", "admin", "content-editor.tsx");
const workspaceSource = readAppFile("components", "admin", "content-workspace.tsx");

/** The primary card: from its marker to the start of the recovery region. */
const recoveryStart = editorSource.indexOf('data-testid="admin-recovery-tools"');
const primaryStart = editorSource.indexOf('data-testid="admin-primary-actions"');
const primaryRegion = editorSource.slice(primaryStart, recoveryStart);
const recoveryRegion = editorSource.slice(recoveryStart);

const RECOVERY_LABELS = [
  "Restaurer le contenu publié",
  "Sauvegarder sur cet appareil",
  "Restaurer la sauvegarde locale",
  "Exporter une sauvegarde JSON",
  "Importer un fichier JSON",
  "Supprimer la sauvegarde locale",
];

test("both regions exist, in order: primary actions then recovery", () => {
  assert.ok(primaryStart > 0, "the primary action area is missing");
  assert.ok(recoveryStart > 0, "the recovery region is missing");
  assert.ok(
    primaryStart < recoveryStart,
    "the recovery region precedes the primary actions",
  );
});

test("draft state, save, preview and publish are the primary area, and nothing else is", () => {
  // 1. the state of the draft…
  assert.match(primaryRegion, /data-testid="admin-freshness"/);
  assert.match(primaryRegion, /ADMIN_DRAFT_FRESHNESS_LABELS\[freshness\]/);
  assert.match(primaryRegion, /getModificationState\(isDirty\)/);
  assert.match(primaryRegion, /getServerDraftState\(draft\.revision, draft\.updatedAt\)/);
  assert.match(
    primaryRegion,
    /getPublishedState\(draft\.publishedRevision, draft\.publishedAt\)/,
  );
  // …2, 3 and 4: save, preview, publish, in that order.
  const order = ["Enregistrer le brouillon", "Voir l&apos;aperçu", ">\n                  Publier"];
  let cursor = 0;
  for (const label of order) {
    const at = primaryRegion.indexOf(label, cursor);
    assert.ok(at > 0, `the primary area lost ${label}`);
    cursor = at;
  }
  // No recovery control was left in, or duplicated into, the primary area.
  for (const label of RECOVERY_LABELS) {
    assert.ok(
      !primaryRegion.includes(label),
      `${label} is still in the primary action area`,
    );
  }
});

test("the recovery controls are all present, and all subordinate", () => {
  for (const label of RECOVERY_LABELS) {
    assert.ok(
      recoveryRegion.includes(label),
      `the recovery region lost ${label}`,
    );
  }
  // Available, not removed: the file input stays wired to the same handler.
  assert.match(recoveryRegion, /id="admin-draft-import"/);
  assert.match(recoveryRegion, /handleImportDraft\(event\.target\.files\?\.\[0\], editor\.localDocument\)/);
  // A disclosure, so the summary is a native tab stop with a visible ring —
  // not a scripted toggle and not a dialog to escape from.
  assert.match(
    recoveryRegion,
    /<summary className="[^"]*cursor-pointer[^"]*focus:ring-2 focus:ring-sage-300"/,
  );
  assert.doesNotMatch(recoveryRegion, /role="dialog"/);
  assert.doesNotMatch(recoveryRegion, /aria-modal/);
  // It opens itself for the one state inside it that needs acting on, by
  // derivation rather than by an effect writing state — so the operator's own
  // choice comes back as soon as the unreadable backup is gone.
  assert.match(
    editorSource,
    /const isRecoveryOpen = hasOpenedRecovery \|\| hasInvalidStoredBackup;/,
  );
  assert.match(editorSource, /open=\{isRecoveryOpen\}/);
  assert.match(
    editorSource,
    /onToggle=\{\(event\) => setHasOpenedRecovery\(event\.currentTarget\.open\)\}/,
  );
});

test("an active conflict stays in the primary area, expanded", () => {
  assert.match(primaryRegion, /data-testid="admin-revision-conflict"/);
  assert.match(primaryRegion, /Fusionner avec la version du serveur/);
  assert.match(primaryRegion, /Recharger la version du serveur/);
  // Never behind the collapsible region.
  assert.doesNotMatch(recoveryRegion, /admin-revision-conflict/);
  // Still an alert, still gated on the in-flight operation only.
  assert.match(primaryRegion, /role="alert"\s*\n\s*data-testid="admin-revision-conflict"/);
  assert.match(primaryRegion, /disabled=\{draft\.busy !== null\}/);
});

test("conflict guidance points at the visible recovery summary, not a hidden control", () => {
  const guidance = primaryRegion.slice(
    primaryRegion.indexOf("Reprenez ces éléments"),
  );
  // The JSON export lives inside the collapsed region, so the banner must not
  // claim it is already visible below the conflict.
  assert.doesNotMatch(guidance, /export JSON ci-dessous/);
  // It names the one thing that *is* visible while the region stays closed.
  assert.match(guidance, /Sauvegardes et récupération/);
});

test("the blocking and announcing surfaces stay outside the collapsible region", () => {
  // The polite status line and the error alert are what a save reports through.
  assert.match(primaryRegion, /role="status"\s*\n\s*aria-live="polite"/);
  assert.match(primaryRegion, /\{draft\.statusMessage\}/);
  assert.match(primaryRegion, /\{draft\.errorMessage\}/);
  assert.doesNotMatch(recoveryRegion, /draft\.statusMessage/);
  assert.doesNotMatch(recoveryRegion, /draft\.errorMessage/);
});

test("the local backup is never presented as canonical", () => {
  // The device backup's own state line moved out of the primary state summary…
  assert.doesNotMatch(primaryRegion, /getLocalBackupState/);
  assert.match(recoveryRegion, /getLocalBackupState\(backupSavedAt\)/);
  // …and the region says, in words, which side is authoritative.
  assert.match(recoveryRegion, /Le brouillon du serveur fait autorité/);
  assert.match(recoveryRegion, /secours/);
  assert.match(recoveryRegion, /ne remplacent jamais le\s+brouillon du serveur/);
  // The primary heading still names the server as where a saved draft lives.
  assert.match(primaryRegion, /Brouillon enregistré sur le serveur/);
});

test("no handler, gate or revision rule was rewritten by the reordering", () => {
  // Each control still calls the controller/backup callback it already called.
  assert.match(primaryRegion, /onClick=\{\(\) => \{\s*\n\s*void editor\.handleSaveDraft\(\);/);
  assert.match(primaryRegion, /onClick=\{\(\) => \{\s*\n\s*void editor\.handlePublish\(\);/);
  assert.match(primaryRegion, /onClick=\{handleShowPreview\}/);
  assert.match(recoveryRegion, /void editor\.handleResetToPublished\(\);/);
  assert.match(recoveryRegion, /handleSaveLocalBackup\(editor\.localDocument\)/);
  assert.match(recoveryRegion, /handleRestoreLocalBackup\(editor\.localDocument\)/);
  assert.match(recoveryRegion, /handleExportDraft\(editor\.localDocument\)/);
  assert.match(recoveryRegion, /handleDeleteLocalBackup\(\)/);
  // The three privileged writes keep the one gate `canWrite` computes, and the
  // preview — which writes nothing — keeps none.
  assert.equal(
    (editorSource.match(/disabled=\{!writesAllowed\}/g) ?? []).length,
    3,
    "the number of controls gated on canWrite changed",
  );
  assert.match(editorSource, /const writesAllowed = canWrite\(draft\);/);
  // No autosave, no autopublish: the writes happen in click handlers only.
  for (const call of ["handleSaveDraft", "handlePublish", "handleResetToPublished"]) {
    assert.doesNotMatch(
      editorSource,
      new RegExp(`useEffect\\([^}]*${call}`),
      `${call} is reachable from an effect`,
    );
  }
  // Navigating sections or opening the preview cannot write either: the
  // workspace has no action of its own to call.
  assert.doesNotMatch(workspaceSource, /handleSaveDraft|handlePublish|handleResetToPublished/);
});

test("the primary and recovery controls stay reachable on a narrow screen", () => {
  // Both rows stack before they wrap, and every control keeps a 44 px target.
  assert.match(primaryRegion, /flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap/);
  assert.match(recoveryRegion, /flex flex-col gap-2 sm:flex-row sm:flex-wrap/);
  const primaryButtons = primaryRegion.match(/min-h-11/g) ?? [];
  assert.ok(primaryButtons.length >= 3, "a primary control lost its touch target");
  const recoveryButtons = recoveryRegion.match(/min-h-11/g) ?? [];
  assert.ok(
    recoveryButtons.length >= RECOVERY_LABELS.length,
    "a recovery control lost its touch target",
  );
});
