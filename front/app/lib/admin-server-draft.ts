import type {
  PublishedContentEnvelopeV1,
  ServerDraftEnvelopeV1,
} from "@eszter/contracts";
import { ADMIN_API_MESSAGES, type AdminApiFailure } from "./admin-api";
import type { SiteContentMergeConflict } from "./site-content-merge";

/**
 * The editor's server-draft state machine (ESZ-034).
 *
 * The whole point of extracting it from the component is that every transition
 * this package cares about — a stale save, an expired session, a conflict and
 * the reconciliation that follows it — is a pure function of `(state, action)`
 * and can be driven by a test without a DOM, a browser or a running PHP. The
 * component keeps the parts React has to own: the content being edited, and the
 * dirty flag that follows from typing.
 *
 * ## The one invariant
 *
 * `revision` is the draft head this editor believes it is based on, and it moves
 * **only** when the server hands back an envelope — that is, a revision together
 * with the content that belongs to it. Nothing optimistic writes it, no failed
 * operation advances it, and no action derives it from a response header.
 *
 * That last clause is the correction this package carries. A 409 reports the
 * current head in `X-Content-Revision`, and an earlier version of this reducer
 * had an action that adopted it — which let the next save replace content the
 * editor had never read. {@link reportedServerRevision} keeps that number for
 * display only; the only way out of a conflict is
 * {@link ../lib/admin-draft-reconciliation}, which fetches the content first.
 */

export type AdminDraftPhase =
  /** The bootstrap read of `GET /api/admin/content/draft` is in flight. */
  | "loading"
  /** A server draft is loaded and its revision is known. */
  | "ready"
  /** The last write was refused with 409 and is not yet reconciled. */
  | "conflict"
  /** A privileged call returned 401. Nothing more may be attempted. */
  | "expired"
  /** The draft could not be loaded at all. The editor is read-only. */
  | "unavailable";

export type AdminDraftOperation =
  | "loading"
  | "saving"
  | "publishing"
  | "resetting"
  /** The three-way reconciliation that follows a refused save. */
  | "reconciling";

export interface AdminDraftState {
  phase: AdminDraftPhase;
  /** The draft head this editor is based on; `null` until one is loaded. */
  revision: number | null;
  updatedAt: string | null;
  /** The published head, from `GET /api/content` or a publish response. */
  publishedRevision: number | null;
  publishedAt: string | null;
  /** The call currently in flight, so the UI can disable exactly one thing. */
  busy: AdminDraftOperation | null;
  statusMessage: string;
  errorMessage: string | null;
  /**
   * The head the server reported alongside a 409, or `null` when it sent none.
   *
   * Display only. It tells the admin how far behind they are; it is never a
   * value `revision` can be assigned from, because the content of that revision
   * has not been read.
   */
  reportedServerRevision: number | null;
  /** What a reconciliation could not decide. Empty unless it ran and refused. */
  conflicts: SiteContentMergeConflict[];
}

export type AdminDraftAction =
  | { type: "bootstrap-start" }
  | { type: "draft-loaded"; envelope: ServerDraftEnvelopeV1 }
  | { type: "published-loaded"; envelope: PublishedContentEnvelopeV1 }
  | { type: "published-unknown" }
  | { type: "operation-start"; operation: AdminDraftOperation }
  | { type: "draft-saved"; envelope: ServerDraftEnvelopeV1 }
  | { type: "draft-reset"; envelope: ServerDraftEnvelopeV1 }
  | { type: "content-published"; envelope: PublishedContentEnvelopeV1 }
  | {
      type: "operation-failed";
      operation: AdminDraftOperation;
      failure: AdminApiFailure;
    }
  /** The admin chose to discard local edits and take the server draft. */
  | { type: "conflict-reloaded"; envelope: ServerDraftEnvelopeV1 }
  /** Reconciliation merged cleanly and the merged document was saved. */
  | { type: "conflict-merged"; envelope: ServerDraftEnvelopeV1 }
  /** Reconciliation found the server already held everything local had. */
  | { type: "conflict-already-current"; envelope: ServerDraftEnvelopeV1 }
  /** Reconciliation refused. Nothing was written; the editor stays conflicted. */
  | {
      type: "conflict-unresolved";
      conflicts: SiteContentMergeConflict[];
      reportedServerRevision: number | null;
    }
  /** Publish or reset was refused; the current server state has been re-read. */
  | {
      type: "conflict-refreshed";
      envelope: ServerDraftEnvelopeV1;
      operation: "publishing" | "resetting";
      /** Whether the fetched content was actually applied to the editor. */
      contentAdopted: boolean;
    }
  | { type: "local-message"; statusMessage: string }
  | { type: "local-error"; errorMessage: string | null };

export const ADMIN_DRAFT_MESSAGES = {
  loading: "Chargement du brouillon depuis le serveur…",
  loaded: "Brouillon chargé depuis le serveur.",
  saving: "Enregistrement du brouillon sur le serveur…",
  saved: "Brouillon enregistré sur le serveur. Le site public reste inchangé.",
  publishing: "Publication en cours…",
  published: "Contenu publié. Le site public affiche désormais ce contenu.",
  resetting: "Restauration du contenu publié…",
  reset:
    "Le brouillon a été remplacé par le contenu publié. Le site public reste inchangé.",
  conflict:
    "Conflit de version : le brouillon du serveur a changé depuis son chargement. Rien n’a été écrit. Vos modifications sont intactes dans l’éditeur et une sauvegarde locale a été écrite.",
  reconciling:
    "Comparaison de vos modifications avec le brouillon du serveur…",
  conflictMerged:
    "Les deux versions ont été fusionnées : aucune modification ne se chevauchait. Le résultat est enregistré sur le serveur.",
  conflictAlreadyCurrent:
    "Le brouillon du serveur contenait déjà vos modifications. Rien n’a été réécrit et l’éditeur est aligné sur la version du serveur.",
  conflictUnresolved:
    "Fusion impossible : les mêmes éléments ont été modifiés des deux côtés. Rien n’a été écrit sur le serveur. Votre travail reste affiché ici et sauvegardé sur cet appareil.",
  conflictReloaded:
    "Le brouillon du serveur a été rechargé dans l’éditeur. Vos modifications précédentes restent disponibles dans la sauvegarde locale.",
  conflictRefreshedPublish:
    "La publication a été refusée : le brouillon avait changé. L’état du serveur a été relu. Vérifiez le contenu puis relancez la publication si c’est bien ce que vous voulez publier.",
  conflictRefreshedReset:
    "La restauration a été refusée : le brouillon avait changé. L’état du serveur a été relu. Relancez la restauration si c’est toujours ce que vous voulez faire.",
  expired: ADMIN_API_MESSAGES.unauthenticated,
  unavailable:
    "Le brouillon du serveur n’a pas pu être chargé. L’éditeur reste en lecture seule tant que le serveur ne répond pas.",
} as const;

export function createInitialDraftState(): AdminDraftState {
  return {
    phase: "loading",
    revision: null,
    updatedAt: null,
    publishedRevision: null,
    publishedAt: null,
    busy: "loading",
    statusMessage: ADMIN_DRAFT_MESSAGES.loading,
    errorMessage: null,
    reportedServerRevision: null,
    conflicts: [],
  };
}

/**
 * What the header shows: is this content unsaved, saved but unpublished, or live?
 *
 * Derived rather than stored, because a stored third flag is a fourth state
 * waiting to disagree with the other two. `unknown` is a real answer: before
 * `GET /api/content` reports the published head, claiming "unpublished" would be
 * a guess about the public site.
 */
export type AdminDraftFreshness =
  | "unsaved"
  | "saved-unpublished"
  | "published"
  | "unknown";

export function describeDraftFreshness(
  state: AdminDraftState,
  isDirty: boolean,
): AdminDraftFreshness {
  if (isDirty) return "unsaved";
  if (state.revision === null) return "unknown";
  if (state.publishedRevision === null) return "unknown";
  return state.publishedRevision === state.revision
    ? "published"
    : "saved-unpublished";
}

export const ADMIN_DRAFT_FRESHNESS_LABELS: Record<AdminDraftFreshness, string> = {
  unsaved: "Modifications non enregistrées",
  "saved-unpublished": "Brouillon enregistré, non publié",
  published: "Publié",
  unknown: "État de publication inconnu",
};

/**
 * Applies a failure without ever advancing the revision.
 *
 * An expiry ends the phase for good — the session is gone and every subsequent
 * privileged call would 401 too, so leaving the editor in `ready` would offer
 * buttons that cannot work. A conflict moves to `conflict`, which is the only
 * phase that offers a reconciliation. Everything else keeps the phase it had: a
 * failed save on a loaded draft leaves a loaded draft.
 */
function applyFailure(
  state: AdminDraftState,
  operation: AdminDraftOperation,
  failure: AdminApiFailure,
): AdminDraftState {
  const base: AdminDraftState = {
    ...state,
    busy: null,
    errorMessage: failure.message,
  };

  if (failure.kind === "unauthenticated") {
    return {
      ...base,
      phase: "expired",
      statusMessage: ADMIN_DRAFT_MESSAGES.expired,
      reportedServerRevision: null,
    };
  }

  if (failure.kind === "conflict") {
    return {
      ...base,
      phase: "conflict",
      statusMessage: ADMIN_DRAFT_MESSAGES.conflict,
      // Recorded for the banner, not for `revision`. The content behind this
      // number has not been read, so nothing may be written against it.
      reportedServerRevision: failure.currentRevision,
    };
  }

  if (operation === "loading") {
    return {
      ...base,
      phase: "unavailable",
      statusMessage: ADMIN_DRAFT_MESSAGES.unavailable,
    };
  }

  return base;
}

export function adminDraftReducer(
  state: AdminDraftState,
  action: AdminDraftAction,
): AdminDraftState {
  switch (action.type) {
    case "bootstrap-start":
      return {
        ...createInitialDraftState(),
        publishedRevision: state.publishedRevision,
        publishedAt: state.publishedAt,
      };

    case "draft-loaded":
    case "conflict-reloaded":
      return {
        ...state,
        phase: "ready",
        busy: null,
        revision: action.envelope.revision,
        updatedAt: action.envelope.updatedAt,
        errorMessage: null,
        reportedServerRevision: null,
        conflicts: [],
        statusMessage:
          action.type === "draft-loaded"
            ? ADMIN_DRAFT_MESSAGES.loaded
            : ADMIN_DRAFT_MESSAGES.conflictReloaded,
      };

    case "published-loaded":
      return {
        ...state,
        publishedRevision: action.envelope.revision,
        publishedAt: action.envelope.publishedAt,
      };

    case "published-unknown":
      return { ...state, publishedRevision: null, publishedAt: null };

    case "operation-start":
      return {
        ...state,
        busy: action.operation,
        errorMessage: null,
        statusMessage:
          action.operation === "saving"
            ? ADMIN_DRAFT_MESSAGES.saving
            : action.operation === "publishing"
              ? ADMIN_DRAFT_MESSAGES.publishing
              : action.operation === "resetting"
                ? ADMIN_DRAFT_MESSAGES.resetting
                : action.operation === "reconciling"
                  ? ADMIN_DRAFT_MESSAGES.reconciling
                  : ADMIN_DRAFT_MESSAGES.loading,
      };

    case "draft-saved":
    case "draft-reset":
    case "conflict-merged":
    case "conflict-already-current":
      return {
        ...state,
        phase: "ready",
        busy: null,
        // Every one of these carries a server envelope: a revision *and* the
        // content it belongs to. That is the only thing `revision` moves for.
        revision: action.envelope.revision,
        updatedAt: action.envelope.updatedAt,
        errorMessage: null,
        reportedServerRevision: null,
        conflicts: [],
        statusMessage:
          action.type === "draft-saved"
            ? ADMIN_DRAFT_MESSAGES.saved
            : action.type === "draft-reset"
              ? ADMIN_DRAFT_MESSAGES.reset
              : action.type === "conflict-merged"
                ? ADMIN_DRAFT_MESSAGES.conflictMerged
                : ADMIN_DRAFT_MESSAGES.conflictAlreadyCurrent,
      };

    case "conflict-refreshed":
      return {
        ...state,
        // Back to `ready` only when the fetched draft actually replaced what is
        // on screen. Otherwise the editor still holds unsaved work against a
        // stale head, which is the conflict phase by definition — and where
        // reconciliation is offered rather than forced.
        phase: action.contentAdopted ? "ready" : "conflict",
        busy: null,
        // Adopted only when the fetched content was actually applied to the
        // editor. A refresh that could not replace the on-screen document — the
        // admin has unsaved work — leaves this editor exactly as stale as it
        // was, so its next write is refused rather than blindly accepted.
        revision: action.contentAdopted ? action.envelope.revision : state.revision,
        updatedAt: action.contentAdopted ? action.envelope.updatedAt : state.updatedAt,
        errorMessage: null,
        reportedServerRevision: action.contentAdopted
          ? null
          : action.envelope.revision,
        conflicts: [],
        statusMessage:
          action.operation === "publishing"
            ? ADMIN_DRAFT_MESSAGES.conflictRefreshedPublish
            : ADMIN_DRAFT_MESSAGES.conflictRefreshedReset,
      };

    case "content-published":
      return {
        ...state,
        phase: "ready",
        busy: null,
        publishedRevision: action.envelope.revision,
        publishedAt: action.envelope.publishedAt,
        errorMessage: null,
        reportedServerRevision: null,
        conflicts: [],
        statusMessage: ADMIN_DRAFT_MESSAGES.published,
      };

    case "operation-failed":
      return applyFailure(state, action.operation, action.failure);

    case "conflict-unresolved":
      // No write happened and none may be attempted: `revision` stays exactly
      // where it was, so the next save is refused under the lock too.
      return {
        ...state,
        phase: "conflict",
        busy: null,
        conflicts: action.conflicts,
        reportedServerRevision: action.reportedServerRevision,
        statusMessage: ADMIN_DRAFT_MESSAGES.conflictUnresolved,
        errorMessage: null,
      };

    case "local-message":
      return { ...state, statusMessage: action.statusMessage };

    case "local-error":
      return { ...state, errorMessage: action.errorMessage };

    default:
      return state;
  }
}

/**
 * Whether a privileged write may be attempted at all.
 *
 * Not access control — PHP decides that — but the difference between a button
 * that fails usefully and one that cannot possibly succeed. A `null` revision is
 * disqualifying on its own: `expectedRevision` is required by the contract, and a
 * client with no head to state has nothing to send.
 */
export function canWrite(state: AdminDraftState): boolean {
  return (
    state.busy === null &&
    state.revision !== null &&
    (state.phase === "ready" || state.phase === "conflict")
  );
}
