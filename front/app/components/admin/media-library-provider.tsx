"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { MediaAssetMetadata, SiteContent } from "@eszter/contracts";
import { useAdminSession } from "./admin-session-provider";
import {
  createInitialMediaLibraryState,
  mediaFailureMessage,
  mediaLibraryReducer,
  mediaUsagesIn,
  type MediaLibraryState,
} from "../../lib/admin-media";

/**
 * The server-backed media library, shared by every media field (ESZ-037).
 *
 * A context rather than props because {@link MediaEditor} appears in four places
 * nested several components deep, and threading a library, an uploader and a
 * deleter through `HeroEditor`, `ServicesEditor`, `GalleryEditor` and
 * `AboutEditor` would put media plumbing in four components that have nothing to
 * do with media. The context is also what makes "one library, one fetch" true:
 * four independent panels would each read `GET /api/admin/media` on mount.
 *
 * ## What it does not own
 *
 * The content being edited. It is *given* the current document so it can count
 * usages for the delete warning, and it never writes one: selecting an asset
 * calls the field's own `onChange`, which is the ordinary draft workflow every
 * other field uses. There is exactly one content authority and this is not it.
 *
 * ## Lazy, on purpose
 *
 * Nothing is fetched until a field asks for the library the first time. Most
 * editing sessions never touch an image, and a panel that read the library on
 * mount would make every page load pay for a feature it did not use.
 */

interface MediaLibraryContextValue {
  state: MediaLibraryState;
  /** Reads the library if it has not been read yet. Safe to call repeatedly. */
  ensureLoaded: () => void;
  /** Re-reads unconditionally, after a delete the server said was already gone. */
  reload: () => Promise<void>;
  upload: (file: File) => Promise<MediaAssetMetadata | null>;
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  confirmDelete: (id: string) => Promise<void>;
  /** How many places in the working draft point at this asset. */
  usagesOf: (path: string) => number;
}

const MediaLibraryContext = createContext<MediaLibraryContextValue | null>(null);

export function useMediaLibrary(): MediaLibraryContextValue | null {
  return useContext(MediaLibraryContext);
}

export function MediaLibraryProvider({
  content,
  children,
}: Readonly<{ content: SiteContent; children: React.ReactNode }>) {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const [state, dispatch] = useReducer(
    mediaLibraryReducer,
    undefined,
    createInitialMediaLibraryState,
  );

  const mountedRef = useRef(true);
  // Read through a ref rather than as a dependency: the document changes on
  // every keystroke, and a `usagesOf` that depended on it would be rebuilt — and
  // the whole context value with it — on each one, re-rendering every media
  // field in the editor while someone types in a text box.
  //
  // Written in an effect rather than during render. Assigning during render is
  // a tearing hazard under concurrent rendering (a render that is thrown away
  // still leaves its write behind) and React's lint rule is right to refuse it.
  // The one-render lag it costs is invisible here: `usagesOf` is read when the
  // library panel draws a delete control, never during the render that changed
  // the document.
  const contentRef = useRef(content);
  const requestedRef = useRef(false);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Turns a 401 into the signed-out screen and a 403 into a token refresh.
   *
   * The same two recoveries the content editor performs, for the same reasons: a
   * dead session must not leave working buttons behind, and a stale CSRF token is
   * recoverable by re-reading the session rather than by making the admin sign in
   * again.
   */
  const handleFailure = useCallback(
    (failure: Parameters<typeof mediaFailureMessage>[0]) => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") {
        void refreshSession();
      }
    },
    [markExpired, refreshSession],
  );

  const read = useCallback(async () => {
    dispatch({ type: "load-start" });

    const result = await api.listMedia();
    if (!mountedRef.current) return;

    if (!result.ok) {
      handleFailure(result.failure);
      dispatch({
        type: "load-failed",
        failure: { ...result.failure, message: mediaFailureMessage(result.failure) },
      });
      return;
    }

    dispatch({ type: "loaded", assets: result.value });
  }, [api, handleFailure]);

  const ensureLoaded = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void read();
  }, [read]);

  const upload = useCallback(
    async (file: File): Promise<MediaAssetMetadata | null> => {
      dispatch({ type: "upload-start" });

      const result = await api.uploadMedia(file, csrfToken);
      if (!mountedRef.current) return null;

      if (!result.ok) {
        handleFailure(result.failure);
        dispatch({
          type: "upload-failed",
          failure: { ...result.failure, message: mediaFailureMessage(result.failure) },
        });
        return null;
      }

      dispatch({ type: "uploaded", asset: result.value });

      // Deliberately does not select it. Uploading gathers an image; using one
      // is an edit to the draft the admin makes on purpose.
      return result.value;
    },
    [api, csrfToken, handleFailure],
  );

  const confirmDelete = useCallback(
    async (id: string) => {
      dispatch({ type: "delete-start" });

      const result = await api.deleteMedia(id, csrfToken);
      if (!mountedRef.current) return;

      if (!result.ok) {
        handleFailure(result.failure);
        dispatch({
          type: "delete-failed",
          failure: { ...result.failure, message: mediaFailureMessage(result.failure) },
        });

        // A 404 means the server has just told us this asset is gone, which is a
        // fact about the library rather than a failure of it. Re-reading is the
        // only way to stop showing something that is not there; guessing it away
        // would be the same optimism the reducer refuses everywhere else.
        if (result.failure.kind === "not-found") {
          void read();
        }
        return;
      }

      dispatch({ type: "deleted", id });
    },
    [api, csrfToken, handleFailure, read],
  );

  const value = useMemo<MediaLibraryContextValue>(
    () => ({
      state,
      ensureLoaded,
      reload: read,
      upload,
      requestDelete: (id: string) => dispatch({ type: "delete-requested", id }),
      cancelDelete: () => dispatch({ type: "delete-cancelled" }),
      confirmDelete,
      usagesOf: (path: string) => mediaUsagesIn(contentRef.current, path),
    }),
    [state, ensureLoaded, read, upload, confirmDelete],
  );

  return (
    <MediaLibraryContext.Provider value={value}>
      {children}
    </MediaLibraryContext.Provider>
  );
}
