import type {
  PublishedContentEnvelopeV1,
  ServerDraftEnvelopeV1,
  SiteContent,
} from "@eszter/contracts";
import type { AdminApiFailure, AdminApiResult } from "./admin-api";
import { cloneSiteContent } from "./site-content-clone";
import {
  mergeSiteContent,
  type SiteContentMergeConflict,
} from "./site-content-merge";

/**
 * What the editor does about a `409 REVISION_CONFLICT` (ESZ-034).
 *
 * The server contract is unchanged and stays that way: every privileged write
 * states `expectedRevision`, and PHP refuses under the lock with a 409 when the
 * draft has moved. That refusal is the safety barrier. What this module replaces
 * is the browser's old answer to it — adopt the head named in the response
 * header and write again — which discarded the other editor's work without ever
 * reading it.
 *
 * The rule everything here is built around: **a revision becomes authoritative
 * only from an envelope the server sent with the content that belongs to it.**
 * The `X-Content-Revision` header on a 409 is a diagnostic. It is shown, it is
 * logged, and it is never adopted, because adopting a number without its
 * document is precisely the blind rebase this corrects.
 *
 * ## The sequence, and why it is in this order
 *
 * 1. Back up the local working draft to the device. At this instant the content
 *    on screen is the only copy of the admin's work that exists anywhere.
 * 2. Fetch the current server draft — the *content*, not just the head.
 * 3. Merge base / local / server deterministically.
 * 4. If anything conflicts, stop. No write is attempted, nothing on screen is
 *    replaced, and the backup stays.
 * 5. Otherwise save the merged document once, against the revision that came
 *    back in step 2's envelope.
 *
 * Step 5 runs **once**. A second 409 means a third editor wrote between the
 * fetch and the save, and retrying would be a loop whose termination depends on
 * other people typing slowly. It is reported as a conflict for a fresh, explicit
 * attempt instead.
 */

/** The two calls reconciliation makes, narrowed so tests can drive them. */
export interface DraftReconciliationPorts {
  readDraft(): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
  saveDraft(
    input: { content: SiteContent; expectedRevision: number },
    csrfToken: string,
  ): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
}

export interface DraftReconciliationInput {
  /** The content of the revision this editor originally loaded. */
  base: SiteContent;
  /** What the admin has on screen, including everything unsaved. */
  local: SiteContent;
  csrfToken: string;
  ports: DraftReconciliationPorts;
  /** Writes the device backup. Returns whether it was actually written. */
  backup: (content: SiteContent) => boolean;
}

export type DraftReconciliationOutcome =
  /** Merged cleanly and saved. `envelope` is the new authoritative head. */
  | {
      kind: "merged-saved";
      envelope: ServerDraftEnvelopeV1;
      content: SiteContent;
      backupWritten: boolean;
    }
  /** The server already contained everything local had. Nothing was written. */
  | {
      kind: "already-current";
      envelope: ServerDraftEnvelopeV1;
      content: SiteContent;
      backupWritten: boolean;
    }
  /** Genuine conflicts. Nothing was written and nothing on screen changed. */
  | {
      kind: "unresolved";
      conflicts: SiteContentMergeConflict[];
      /** The fetched head, safe to adopt only together with its content. */
      serverEnvelope: ServerDraftEnvelopeV1;
      backupWritten: boolean;
    }
  /** A call failed. `stage` says whether anything could have been written. */
  | {
      kind: "failed";
      stage: "read" | "save";
      failure: AdminApiFailure;
      backupWritten: boolean;
    };

export async function reconcileDraftConflict({
  base,
  local,
  csrfToken,
  ports,
  backup,
}: DraftReconciliationInput): Promise<DraftReconciliationOutcome> {
  // Before any network call: the refused save means the server holds none of
  // this, and a reconciliation that failed halfway must still leave the admin's
  // work recoverable from the device.
  const backupWritten = backup(local);

  const fetched = await ports.readDraft();

  if (!fetched.ok) {
    return { kind: "failed", stage: "read", failure: fetched.failure, backupWritten };
  }

  const server = fetched.value;
  const merged = mergeSiteContent(base, local, server.content);

  if (!merged.ok) {
    return {
      kind: "unresolved",
      conflicts: merged.conflicts,
      serverEnvelope: server,
      backupWritten,
    };
  }

  if (!merged.changedFromServer) {
    // The other editor's draft already contains everything this one had — the
    // same edit made twice, typically. Writing an identical document would burn
    // a revision and invalidate a third editor's head for no gain.
    return {
      kind: "already-current",
      envelope: server,
      content: cloneSiteContent(server.content),
      backupWritten,
    };
  }

  // Exactly one attempt, against the revision whose content was just merged.
  const saved = await ports.saveDraft(
    { content: merged.merged, expectedRevision: server.revision },
    csrfToken,
  );

  if (!saved.ok) {
    return { kind: "failed", stage: "save", failure: saved.failure, backupWritten };
  }

  return {
    kind: "merged-saved",
    envelope: saved.value,
    content: cloneSiteContent(saved.value.content),
    backupWritten,
  };
}

/**
 * What publish and reset do about a 409: re-read, then wait to be asked again.
 *
 * Neither operation carries a document, so there is nothing to merge — the whole
 * question is which stored draft the action applies to, and the admin answered
 * that when they pressed the button on a state that has since moved. Re-reading
 * gives them the current one; pressing again is their confirmation that it is
 * still what they meant. Anything automatic here would publish or discard a
 * document nobody looked at.
 */
export interface WriteConflictRefreshPorts {
  readDraft(): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
  readPublished(): Promise<AdminApiResult<PublishedContentEnvelopeV1>>;
}

export type WriteConflictRefresh =
  | {
      kind: "refreshed";
      envelope: ServerDraftEnvelopeV1;
      /** Best-effort; the public head is informational and may be unknown. */
      published: PublishedContentEnvelopeV1 | null;
    }
  | { kind: "failed"; failure: AdminApiFailure };

export async function refreshAfterWriteConflict(
  ports: WriteConflictRefreshPorts,
): Promise<WriteConflictRefresh> {
  const fetched = await ports.readDraft();

  if (!fetched.ok) {
    return { kind: "failed", failure: fetched.failure };
  }

  const published = await ports.readPublished();

  return {
    kind: "refreshed",
    envelope: fetched.value,
    published: published.ok ? published.value : null,
  };
}
