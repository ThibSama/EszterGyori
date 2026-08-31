import type { MediaAssetMetadata, SiteContent } from "@eszter/contracts";
import { MEDIA_PUBLIC_PATH_PREFIX } from "@eszter/contracts";
import { ADMIN_API_MESSAGES, type AdminApiFailure } from "./admin-api";

/**
 * The media library's state machine (ESZ-037).
 *
 * Extracted from the component for the same reason
 * {@link ./admin-server-draft} is: every transition worth asserting — a refused
 * delete, an oversized upload, an expired session mid-upload — is a pure function
 * of `(state, action)` and can be driven by a test without a DOM, a browser or a
 * running PHP.
 *
 * ## What this deliberately is not
 *
 * It is not a second content authority. It holds what the *library* contains —
 * which files exist on the server — and nothing about which of them the site
 * uses. Choosing an asset writes a path into the working draft through the
 * ordinary draft workflow, and this module never touches content: it has no
 * reducer action that can, and {@link mediaUsagesIn} only ever *reads* a
 * document.
 *
 * ## The list is the server's, always
 *
 * No action inserts, removes or edits an entry optimistically. An upload adds
 * the asset the server described; a delete removes the id the server confirmed
 * gone. A library that guessed would show an editor an image that is not there,
 * and the next page load would silently disagree with the one in front of them.
 */

export type MediaLibraryPhase =
  /** Nothing has been asked for yet. The panel has never been opened. */
  | "idle"
  /** The first `GET /api/admin/media` is in flight. */
  | "loading"
  /** A library is loaded. It may legitimately be empty. */
  | "ready"
  /** The library could not be read. Selection still works; uploading does not. */
  | "unavailable";

export type MediaLibraryOperation = "loading" | "uploading" | "deleting";

export interface MediaLibraryState {
  phase: MediaLibraryPhase;
  /** Server order, preserved exactly: newest first, id-descending on ties. */
  assets: MediaAssetMetadata[];
  busy: MediaLibraryOperation | null;
  statusMessage: string;
  errorMessage: string | null;
  /**
   * The asset a delete has been requested for and not yet confirmed.
   *
   * Deleting is the one irreversible action in the admin area — the bytes are
   * gone and the original with them — so it is two steps rather than one. The
   * pending id lives here rather than in the component so the "a second delete
   * cannot start while one is pending" rule is a property of the reducer.
   */
  pendingDeleteId: string | null;
}

export type MediaLibraryAction =
  | { type: "load-start" }
  | { type: "loaded"; assets: MediaAssetMetadata[] }
  | { type: "load-failed"; failure: AdminApiFailure }
  | { type: "upload-start" }
  | { type: "uploaded"; asset: MediaAssetMetadata }
  | { type: "upload-failed"; failure: AdminApiFailure }
  | { type: "delete-requested"; id: string }
  | { type: "delete-cancelled" }
  | { type: "delete-start" }
  | { type: "deleted"; id: string }
  | { type: "delete-failed"; failure: AdminApiFailure };

export const MEDIA_LIBRARY_MESSAGES = {
  idle: "Médiathèque non chargée.",
  loading: "Chargement de la médiathèque…",
  empty:
    "Aucun média sur le serveur. Envoyez une image pour l’utiliser dans le contenu.",
  loaded: "Médiathèque chargée depuis le serveur.",
  uploading: "Envoi de l’image au serveur…",
  uploaded:
    "Image envoyée. Sélectionnez-la pour l’utiliser : le brouillon n’est modifié qu’à ce moment-là.",
  deleting: "Suppression du média…",
  deleted:
    "Média supprimé du serveur. Le contenu n’a pas été modifié.",
  deleteConfirm:
    "Supprimer définitivement ce média ? Le fichier et son original seront effacés. Cette action est irréversible.",
  unavailable:
    "La médiathèque n’a pas pu être chargée. Vous pouvez toujours saisir un chemin ou une URL à la main.",
  selected:
    "Média sélectionné. Enregistrez le brouillon pour conserver ce choix.",
  cleared:
    "Média retiré du champ. Le fichier reste dans la médiathèque : rien n’a été supprimé.",
} as const;

export function createInitialMediaLibraryState(): MediaLibraryState {
  return {
    phase: "idle",
    assets: [],
    busy: null,
    statusMessage: MEDIA_LIBRARY_MESSAGES.idle,
    errorMessage: null,
    pendingDeleteId: null,
  };
}

/**
 * Applies a failure without ever changing the asset list.
 *
 * The list only ever moves on a server confirmation, so a failure of any kind
 * leaves it exactly as it was. The one exception is a `not-found` on delete: the
 * server has just told us the asset is gone, which *is* a confirmation, and the
 * caller reloads rather than guessing — handled by the component, not here.
 */
function applyFailure(
  state: MediaLibraryState,
  operation: MediaLibraryOperation,
  failure: AdminApiFailure,
): MediaLibraryState {
  const base: MediaLibraryState = {
    ...state,
    busy: null,
    pendingDeleteId: null,
    errorMessage: failure.message,
  };

  if (operation === "loading") {
    return {
      ...base,
      phase: "unavailable",
      assets: [],
      statusMessage: MEDIA_LIBRARY_MESSAGES.unavailable,
    };
  }

  // A failed upload or delete on a loaded library leaves a loaded library. The
  // editor keeps working; only the operation did not happen.
  return { ...base, statusMessage: describe(state) };
}

function describe(state: MediaLibraryState): string {
  if (state.phase !== "ready") return MEDIA_LIBRARY_MESSAGES.unavailable;

  return state.assets.length === 0
    ? MEDIA_LIBRARY_MESSAGES.empty
    : MEDIA_LIBRARY_MESSAGES.loaded;
}

export function mediaLibraryReducer(
  state: MediaLibraryState,
  action: MediaLibraryAction,
): MediaLibraryState {
  switch (action.type) {
    case "load-start":
      return {
        ...state,
        phase: state.phase === "ready" ? "ready" : "loading",
        busy: "loading",
        errorMessage: null,
        pendingDeleteId: null,
        statusMessage: MEDIA_LIBRARY_MESSAGES.loading,
      };

    case "loaded": {
      const loaded: MediaLibraryState = {
        ...state,
        phase: "ready",
        // Taken verbatim. The server's order is total and stable by contract,
        // and re-sorting here would be a second ordering to disagree with it.
        assets: action.assets,
        busy: null,
        errorMessage: null,
        pendingDeleteId: null,
        statusMessage: "",
      };

      return { ...loaded, statusMessage: describe(loaded) };
    }

    case "load-failed":
      return applyFailure(state, "loading", action.failure);

    case "upload-start":
      return {
        ...state,
        busy: "uploading",
        errorMessage: null,
        pendingDeleteId: null,
        statusMessage: MEDIA_LIBRARY_MESSAGES.uploading,
      };

    case "uploaded":
      return {
        ...state,
        phase: "ready",
        // Prepended, matching the server's newest-first order, rather than
        // appended and re-sorted: the next read must not reshuffle the list an
        // editor is looking at.
        assets: [action.asset, ...state.assets],
        busy: null,
        errorMessage: null,
        statusMessage: MEDIA_LIBRARY_MESSAGES.uploaded,
      };

    case "upload-failed":
      return applyFailure(state, "uploading", action.failure);

    case "delete-requested":
      // Deliberately does not set `busy`: nothing is in flight yet, and a
      // pending confirmation must not disable the rest of the panel.
      return { ...state, pendingDeleteId: action.id, errorMessage: null };

    case "delete-cancelled":
      return { ...state, pendingDeleteId: null };

    case "delete-start":
      return {
        ...state,
        busy: "deleting",
        errorMessage: null,
        statusMessage: MEDIA_LIBRARY_MESSAGES.deleting,
      };

    case "deleted":
      return {
        ...state,
        assets: state.assets.filter((asset) => asset.id !== action.id),
        busy: null,
        errorMessage: null,
        pendingDeleteId: null,
        statusMessage: MEDIA_LIBRARY_MESSAGES.deleted,
      };

    case "delete-failed":
      return applyFailure(state, "deleting", action.failure);

    default:
      return state;
  }
}

/** Whether a delete may be started at all. Not access control — PHP decides. */
export function canDelete(state: MediaLibraryState): boolean {
  return state.busy === null && state.phase === "ready";
}

/**
 * Every place in a content document that points at `path`.
 *
 * Read-only, and it duplicates a check the server also makes — deliberately, and
 * for a reason that is about the person rather than about safety. PHP refuses a
 * referenced delete and that refusal is the guarantee; but an editor who only
 * learns "still in use" *after* clicking has to go and find where, across nine
 * media slots. Showing the count next to the asset turns the refusal into
 * something they could see coming.
 *
 * It is not a permission check and nothing branches on it being right: the
 * delete is attempted regardless and the server's answer is what counts.
 *
 * The walk mirrors the server's — every string under a key named `src`, at any
 * depth — so the two cannot disagree about what a reference is.
 */
export function mediaUsagesIn(content: SiteContent, path: string): number {
  let count = 0;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }

    if (node === null || typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (key === "src" && value === path) {
        count += 1;
        continue;
      }
      walk(value);
    }
  };

  walk(content);

  return count;
}

/** Whether a `MediaAsset.src` points at a server-managed asset. */
export function isManagedMediaPath(source: string | null): boolean {
  return source !== null && source.startsWith(MEDIA_PUBLIC_PATH_PREFIX);
}

/**
 * A byte count as an editor should read it.
 *
 * Binary units with decimal-ish labels, matching what every operating system
 * shows for a file — an editor comparing this against what their file manager
 * says must not find two different numbers.
 */
export function formatMediaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} o`;

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} Ko`;

  return `${(kilobytes / 1024).toFixed(1)} Mo`;
}

/** `1600 × 1067` for the metadata line. */
export function formatMediaDimensions(asset: MediaAssetMetadata): string {
  return `${asset.width} × ${asset.height}`;
}

/**
 * The message for a failure that happened inside the media panel.
 *
 * Exported so the tests assert the editor shows *these* strings rather than a
 * regex-shaped approximation, and so the panel and the editor cannot drift into
 * describing the same failure two ways.
 */
export function mediaFailureMessage(failure: AdminApiFailure): string {
  return failure.kind === "validation"
    ? ADMIN_API_MESSAGES.mediaRejected
    : failure.message;
}
