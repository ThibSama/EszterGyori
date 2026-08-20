import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent, type ServerDraftEnvelopeV1 } from "@eszter/contracts";
import type { AdminApiResult } from "../app/lib/admin-api";
import {
  reconcileDraftConflict,
  refreshAfterWriteConflict,
} from "../app/lib/admin-draft-reconciliation";
import type { SiteContent } from "../app/types/site-content";

/**
 * ESZ-034 — what the editor does about a 409, and what it must never do.
 *
 * The defect this suite exists to prevent regressing: the browser used to be
 * able to take the head named in the `409` response header and write again
 * against it, so whatever the other editor had saved was replaced by a document
 * that had never been compared to it. Optimistic concurrency was intact; the
 * client was walking around it.
 *
 * So every test below asserts on two things at once — the outcome, and the calls
 * that produced it. "No write was attempted" is not visible in a returned value,
 * and it is the property that matters most.
 */

function edit(mutate: (content: SiteContent) => void): SiteContent {
  const content = structuredClone(defaultSiteContent) as SiteContent;
  mutate(content);
  return content;
}

const base = structuredClone(defaultSiteContent) as SiteContent;

function envelope(revision: number, content: SiteContent): ServerDraftEnvelopeV1 {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: "2026-08-20T12:00:00.000Z",
    content,
  };
}

interface Recorder {
  readDraftCalls: number;
  saveCalls: { content: SiteContent; expectedRevision: number }[];
  backups: SiteContent[];
}

function ports(
  reads: AdminApiResult<ServerDraftEnvelopeV1>[],
  saves: AdminApiResult<ServerDraftEnvelopeV1>[],
) {
  const recorder: Recorder = { readDraftCalls: 0, saveCalls: [], backups: [] };

  return {
    recorder,
    ports: {
      readDraft: () => {
        const result = reads[recorder.readDraftCalls];
        recorder.readDraftCalls += 1;
        assert.ok(result, "readDraft was called more times than the test allows");
        return Promise.resolve(result);
      },
      saveDraft: (input: { content: SiteContent; expectedRevision: number }) => {
        const result = saves[recorder.saveCalls.length];
        recorder.saveCalls.push(input);
        assert.ok(result, "saveDraft was called more times than the test allows");
        return Promise.resolve(result);
      },
    },
    backup: (content: SiteContent) => {
      recorder.backups.push(structuredClone(content) as SiteContent);
      return true;
    },
  };
}

test("two tabs editing different sections: merged, then saved once against the fetched head", async () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "Un regard";
  });
  const server = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });
  const merged = edit((content) => {
    content.hero.title.emphasized = "Un regard";
    content.contact.title = "Écrivez-moi";
  });

  const harness = ports([{ ok: true, value: envelope(11, server) }], [
    { ok: true, value: envelope(12, merged) },
  ]);

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  assert.equal(outcome.kind, "merged-saved");
  if (outcome.kind !== "merged-saved") return;
  assert.equal(outcome.envelope.revision, 12);
  assert.equal(outcome.content.hero.title.emphasized, "Un regard");
  assert.equal(outcome.content.contact.title, "Écrivez-moi");

  // Exactly one write, and its precondition is the revision that came back with
  // the content that was merged — never a number read off a 409 header.
  assert.equal(harness.recorder.saveCalls.length, 1);
  assert.equal(harness.recorder.saveCalls[0]!.expectedRevision, 11);
  assert.equal(harness.recorder.saveCalls[0]!.content.contact.title, "Écrivez-moi");
});

test("the local draft is backed up before anything else happens", async () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "À sauvegarder";
  });
  const harness = ports([{ ok: false, failure: { kind: "network", message: "hors ligne" } }], []);

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  // The read failed, so recovery got nowhere — and the work on screen is still
  // the only copy that exists. The backup has to precede the network, not follow
  // a successful path through it.
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.stage, "read");
  assert.equal(outcome.backupWritten, true);
  assert.equal(harness.recorder.backups.length, 1);
  assert.equal(
    harness.recorder.backups[0]!.hero.title.emphasized,
    "À sauvegarder",
  );
  assert.equal(harness.recorder.saveCalls.length, 0);
});

test("same-field conflicts write nothing at all", async () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "Version locale";
  });
  const server = edit((content) => {
    content.hero.title.emphasized = "Version serveur";
  });

  const harness = ports([{ ok: true, value: envelope(11, server) }], []);

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind !== "unresolved") return;
  assert.deepEqual(outcome.conflicts[0]!.path, ["hero", "title", "emphasized"]);
  // The head is reported back for display only; the caller is forbidden from
  // adopting it, and no write was attempted against it here.
  assert.equal(outcome.serverEnvelope.revision, 11);
  assert.equal(harness.recorder.saveCalls.length, 0);
  assert.equal(outcome.backupWritten, true);
});

test("a reordered list is reported as a conflict rather than merged", async () => {
  const local = edit((content) => {
    const links = content.navigation.links;
    [links[0], links[1]] = [links[1]!, links[0]!];
  });
  const server = edit((content) => {
    content.navigation.links[0]!.label = "Prestations et tarifs";
  });

  const harness = ports([{ ok: true, value: envelope(11, server) }], []);

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  assert.equal(outcome.kind, "unresolved");
  if (outcome.kind !== "unresolved") return;
  assert.equal(outcome.conflicts[0]!.kind, "array-shape");
  assert.equal(harness.recorder.saveCalls.length, 0);
});

test("losing the second race fails; it is never retried", async () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "Un regard";
  });
  const server = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });

  const harness = ports(
    [{ ok: true, value: envelope(11, server) }],
    [
      {
        ok: false,
        failure: { kind: "conflict", message: "conflit", currentRevision: 12 },
      },
    ],
  );

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.stage, "save");
  assert.equal(outcome.failure.kind, "conflict");
  // A third editor moved the head between the fetch and the save. Retrying would
  // be a loop whose termination depends on other people typing slowly.
  assert.equal(harness.recorder.saveCalls.length, 1);
  assert.equal(harness.recorder.readDraftCalls, 1);
});

test("a server draft that already contains the local work is not rewritten", async () => {
  const local = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });
  const server = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });

  const harness = ports([{ ok: true, value: envelope(11, server) }], []);

  const outcome = await reconcileDraftConflict({
    base,
    local,
    csrfToken: "token",
    ports: harness.ports,
    backup: harness.backup,
  });

  assert.equal(outcome.kind, "already-current");
  if (outcome.kind !== "already-current") return;
  assert.equal(outcome.envelope.revision, 11);
  // Writing an identical document would burn a revision and invalidate a third
  // editor's head for nothing.
  assert.equal(harness.recorder.saveCalls.length, 0);
});

test("a refused publish or reset re-reads state and stops", async () => {
  let draftReads = 0;
  const server = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });

  const refreshed = await refreshAfterWriteConflict({
    readDraft: () => {
      draftReads += 1;
      return Promise.resolve({ ok: true, value: envelope(11, server) });
    },
    readPublished: () =>
      Promise.resolve({
        ok: true,
        value: {
          schemaVersion: 1,
          revision: 9,
          publishedAt: "2026-08-20T11:00:00.000Z",
          content: base,
        },
      }),
  });

  assert.equal(refreshed.kind, "refreshed");
  if (refreshed.kind !== "refreshed") return;
  assert.equal(refreshed.envelope.revision, 11);
  assert.equal(refreshed.published?.revision, 9);
  // One read, and no path back to publish or reset: the surface exposes neither,
  // so re-attempting the refused operation is not something this code *can* do.
  // Publishing a draft nobody has looked at is exactly what the 409 prevented.
  assert.equal(draftReads, 1);
});

test("a refresh whose read fails reports the failure rather than guessing a head", async () => {
  const refreshed = await refreshAfterWriteConflict({
    readDraft: () =>
      Promise.resolve({ ok: false, failure: { kind: "server", message: "panne", status: 500 } }),
    readPublished: () => {
      throw new Error("the published head must not be read after a failed draft read");
    },
  });

  assert.equal(refreshed.kind, "failed");
});

test("an unreadable published head does not block the refresh", async () => {
  const refreshed = await refreshAfterWriteConflict({
    readDraft: () => Promise.resolve({ ok: true, value: envelope(11, base) }),
    readPublished: () =>
      Promise.resolve({ ok: false, failure: { kind: "network", message: "hors ligne" } }),
  });

  assert.equal(refreshed.kind, "refreshed");
  if (refreshed.kind !== "refreshed") return;
  // The published head only feeds an informational line. Refusing to recover
  // from a conflict because a public read blipped would be a worse answer.
  assert.equal(refreshed.published, null);
});
