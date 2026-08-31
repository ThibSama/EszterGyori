import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import type { AdminApiFailure } from "../app/lib/admin-api";
import {
  ADMIN_DRAFT_MESSAGES,
  adminDraftReducer,
  canWrite,
  createInitialDraftState,
  describeDraftFreshness,
  type AdminDraftAction,
  type AdminDraftState,
} from "../app/lib/admin-server-draft";

/**
 * ESZ-034 — the editor's server-draft state machine.
 *
 * The invariant every test here circles is the same one: `revision` moves only
 * when the server hands back an envelope — a revision together with the content
 * that belongs to it. That is what makes a stale editor incapable of overwriting
 * newer content by accident: its next `expectedRevision` is still the old head,
 * so PHP refuses the write under the lock rather than replacing anything.
 *
 * The head reported in a 409's `X-Content-Revision` is not such an envelope. The
 * transition that used to adopt it is gone, and the test below named for it
 * fails if anything reintroduces the shortcut.
 */

function draft(revision: number, updatedAt = "2026-08-20T10:00:00.000Z") {
  return { schemaVersion: 1 as const, revision, updatedAt, content: defaultSiteContent };
}

function published(revision: number, publishedAt = "2026-08-20T10:05:00.000Z") {
  return { schemaVersion: 1 as const, revision, publishedAt, content: defaultSiteContent };
}

function loaded(revision = 7): AdminDraftState {
  return adminDraftReducer(createInitialDraftState(), {
    type: "draft-loaded",
    envelope: draft(revision),
  });
}

const conflictAt = (currentRevision: number | null): AdminApiFailure => ({
  kind: "conflict",
  message: "conflit",
  currentRevision,
});

test("the editor starts by loading, not by assuming a revision", () => {
  const state = createInitialDraftState();

  assert.equal(state.phase, "loading");
  assert.equal(state.busy, "loading");
  // `expectedRevision` is required by the contract. A client with no head to
  // state has nothing to send, so it must not be allowed to try.
  assert.equal(state.revision, null);
  assert.equal(canWrite(state), false);
});

test("a loaded draft is the source of truth and unlocks writes", () => {
  const state = loaded(7);

  assert.equal(state.phase, "ready");
  assert.equal(state.revision, 7);
  assert.equal(state.updatedAt, "2026-08-20T10:00:00.000Z");
  assert.equal(state.errorMessage, null);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.loaded);
  assert.equal(canWrite(state), true);
});

test("a failed initial load leaves the editor unavailable rather than blank", () => {
  const state = adminDraftReducer(createInitialDraftState(), {
    type: "operation-failed",
    operation: "loading",
    failure: { kind: "server", message: "panne", status: 500 },
  });

  assert.equal(state.phase, "unavailable");
  assert.equal(state.revision, null);
  assert.equal(canWrite(state), false);
  assert.equal(state.errorMessage, "panne");
});

test("a successful save advances the revision the next save will state", () => {
  const state = adminDraftReducer(loaded(7), {
    type: "draft-saved",
    envelope: draft(8, "2026-08-20T11:00:00.000Z"),
  });

  assert.equal(state.revision, 8);
  assert.equal(state.updatedAt, "2026-08-20T11:00:00.000Z");
  assert.equal(state.busy, null);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.saved);
  // Saving a draft never touches published content.
  assert.equal(state.publishedRevision, null);
});

test("a stale save is refused without moving anything the editor holds", () => {
  const before = loaded(7);
  const after = adminDraftReducer(before, {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });

  assert.equal(after.phase, "conflict");
  // The whole point: a refused write leaves this editor exactly as stale as it
  // was. Advancing here would let the *next* save succeed and silently replace
  // the newer server content this one was refused for.
  assert.equal(after.revision, 7);
  // The reported head is display only. Nothing may be written against it until
  // its content has actually been read.
  assert.equal(after.reportedServerRevision, 11);
  assert.equal(after.statusMessage, ADMIN_DRAFT_MESSAGES.conflict);
  assert.match(after.statusMessage, /modifications sont intactes/i);
});

test("resolving a conflict by reloading takes the server revision and content", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-reloaded",
    envelope: draft(11),
  });

  assert.equal(state.phase, "ready");
  assert.equal(state.revision, 11);
  assert.equal(state.reportedServerRevision, null);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictReloaded);
  assert.match(state.statusMessage, /sauvegarde locale/i);
});

test("a clean reconciliation adopts the revision the save envelope carried", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-merged",
    envelope: draft(12, "2026-08-20T12:00:00.000Z"),
  });

  assert.equal(state.phase, "ready");
  // 12, not 11: the head the *save* returned, with the content it belongs to.
  // The 409's header never becomes a revision this editor writes against.
  assert.equal(state.revision, 12);
  assert.equal(state.updatedAt, "2026-08-20T12:00:00.000Z");
  assert.equal(state.reportedServerRevision, null);
  assert.deepEqual(state.conflicts, []);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictMerged);
});

test("a reconciliation that found nothing to write still adopts the fetched head", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-already-current",
    envelope: draft(11),
  });

  // The envelope was fetched with its content and applied to the editor, so 11
  // is authoritative here in a way the identical number on the 409 was not.
  assert.equal(state.phase, "ready");
  assert.equal(state.revision, 11);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictAlreadyCurrent);
});

test("an unresolved reconciliation leaves the editor exactly as stale as it was", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-unresolved",
    reportedServerRevision: 11,
    conflicts: [
      {
        path: ["hero", "title", "emphasized"],
        kind: "value",
        base: "a",
        local: "b",
        server: "c",
      },
    ],
  });

  assert.equal(state.phase, "conflict");
  // Nothing was written, so the next save must be refused under the lock too.
  // Advancing here is the whole defect this package corrects.
  assert.equal(state.revision, 7);
  assert.equal(state.reportedServerRevision, 11);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictUnresolved);
});

test("no action can turn a reported head into the revision writes are made against", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: conflictAt(11),
  });

  // Every action the reducer accepts that carries no server envelope, applied to
  // a conflicted editor. None of them may reach 11. This is the regression test
  // for the removed "Conserver mes modifications" rebase, and it fails for any
  // future action that reintroduces the same shortcut without its content.
  const withoutEnvelope: AdminDraftAction[] = [
    { type: "published-unknown" },
    { type: "operation-start", operation: "saving" },
    { type: "operation-start", operation: "reconciling" },
    { type: "local-message", statusMessage: "peu importe" },
    { type: "local-error", errorMessage: "peu importe" },
    {
      type: "operation-failed",
      operation: "saving",
      failure: conflictAt(11),
    },
    { type: "conflict-unresolved", conflicts: [], reportedServerRevision: 11 },
  ];

  for (const action of withoutEnvelope) {
    assert.equal(adminDraftReducer(conflicted, action).revision, 7, action.type);
  }
});

test("a refused publish re-reads the server state and waits to be asked again", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "publishing",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-refreshed",
    envelope: draft(11),
    operation: "publishing",
    contentAdopted: true,
  });

  assert.equal(state.phase, "ready");
  assert.equal(state.revision, 11);
  // The copy has to say that publishing did not happen and that a fresh, explicit
  // action is required; a "retry" the editor performs itself would publish a
  // draft nobody looked at.
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictRefreshedPublish);
  assert.match(state.statusMessage, /relancez la publication/i);
});

test("a refused reset on an edited document adopts nothing and stays conflicted", () => {
  const conflicted = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "resetting",
    failure: conflictAt(11),
  });
  const state = adminDraftReducer(conflicted, {
    type: "conflict-refreshed",
    envelope: draft(11),
    operation: "resetting",
    contentAdopted: false,
  });

  // The fetched content could not replace the screen — there is unsaved work on
  // it — so the revision stays where it was and the next write is refused rather
  // than accepted against content this editor never displayed.
  assert.equal(state.phase, "conflict");
  assert.equal(state.revision, 7);
  assert.equal(state.reportedServerRevision, 11);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.conflictRefreshedReset);
});

test("an expired session ends the phase and stops offering writes", () => {
  const state = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: { kind: "unauthenticated", message: "expirée" },
  });

  assert.equal(state.phase, "expired");
  assert.equal(canWrite(state), false);
  assert.equal(state.revision, 7);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.expired);
});

test("a validation refusal keeps the loaded draft usable", () => {
  const state = adminDraftReducer(loaded(7), {
    type: "operation-failed",
    operation: "saving",
    failure: { kind: "validation", message: "refusé" },
  });

  // Storage is unchanged and the session is fine; the admin fixes the field and
  // saves again. Dropping to `unavailable` here would strand them.
  assert.equal(state.phase, "ready");
  assert.equal(state.revision, 7);
  assert.equal(state.errorMessage, "refusé");
  assert.equal(canWrite(state), true);
});

test("publishing moves the published head and leaves the draft head alone", () => {
  const state = adminDraftReducer(loaded(8), {
    type: "content-published",
    envelope: published(8),
  });

  assert.equal(state.revision, 8);
  assert.equal(state.publishedRevision, 8);
  assert.equal(state.publishedAt, "2026-08-20T10:05:00.000Z");
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.published);
});

test("a reset takes the next revision rather than rewinding to the published one", () => {
  const withPublished = adminDraftReducer(loaded(7), {
    type: "published-loaded",
    envelope: published(4),
  });
  const state = adminDraftReducer(withPublished, {
    type: "draft-reset",
    envelope: draft(8),
  });

  // `adminContent.reset.requirements`: the rebuilt draft takes the next revision,
  // so a concurrent editor holding 7 loses its next save instead of silently
  // undoing the reset.
  assert.equal(state.revision, 8);
  assert.equal(state.publishedRevision, 4);
  assert.equal(state.statusMessage, ADMIN_DRAFT_MESSAGES.reset);
});

test("the three states an admin has to tell apart are derived, never stored", () => {
  const saved = adminDraftReducer(loaded(8), {
    type: "published-loaded",
    envelope: published(4),
  });

  assert.equal(describeDraftFreshness(saved, true), "unsaved");
  assert.equal(describeDraftFreshness(saved, false), "saved-unpublished");

  const live = adminDraftReducer(saved, {
    type: "content-published",
    envelope: published(8),
  });
  assert.equal(describeDraftFreshness(live, false), "published");

  // Before the published head is known, "unpublished" would be a guess about
  // what the public is being served. `unknown` is the honest answer.
  assert.equal(describeDraftFreshness(loaded(8), false), "unknown");
});
