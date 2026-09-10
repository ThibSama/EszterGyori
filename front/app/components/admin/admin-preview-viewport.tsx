"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAdminPreviewContentMessage,
  createAdminPreviewNavigationMessage,
  parseAdminPreviewReadyMessage,
} from "../../lib/admin-preview-messaging";
import type { AdminPreviewSectionKey } from "../../lib/admin-preview-sections";
import type { SiteContent } from "../../types/site-content";

type PreviewMode = "phone" | "tablet" | "desktop";

/** How long the editor keeps offering the document to a preview that has not
 *  answered yet: at most twelve seconds, and normally one tick or none. */
const HANDSHAKE_INTERVAL_MS = 400;
const HANDSHAKE_ATTEMPTS = 30;

const PREVIEW_DIMENSIONS: Record<
  PreviewMode,
  { label: string; width: number; height: number }
> = {
  phone: { label: "Téléphone", width: 390, height: 844 },
  tablet: { label: "Tablette", width: 768, height: 1024 },
  desktop: { label: "Ordinateur", width: 1440, height: 900 },
};

export function AdminPreviewViewport({
  content,
  activeSection,
}: {
  content: SiteContent;
  activeSection: AdminPreviewSectionKey;
}) {
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const frameAreaRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handshakeIntervalRef = useRef(0);
  const previewAcknowledgedRef = useRef(false);
  const sendCurrentRef = useRef(() => {});
  const dimensions = PREVIEW_DIMENSIONS[mode];
  const browserBarHeight = mode === "phone" ? 0 : 32;
  const framePadding = 24;
  const logicalFrameHeight = dimensions.height + browserBarHeight;
  // The iframe keeps the real device viewport. The outer wrapper reserves only
  // the scaled physical size so transforms cannot crop or expand the layout.
  const scale =
    availableSize.width > 0 && availableSize.height > 0
      ? Math.min(
          1,
          Math.max(
            0,
            Math.min(
              Math.max(0, availableSize.width - framePadding) / dimensions.width,
              Math.max(0, availableSize.height - framePadding) /
                logicalFrameHeight,
            ),
          ),
        )
      : 1;

  const sendContent = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      createAdminPreviewContentMessage(content),
      window.location.origin,
    );
  }, [content]);

  const sendNavigation = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      iframeRef.current?.contentWindow?.postMessage(
        createAdminPreviewNavigationMessage(activeSection, behavior),
        window.location.origin,
      );
    },
    [activeSection],
  );

  useEffect(() => {
    const element = frameAreaRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setAvailableSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  /**
   * The current document, reachable from a callback created earlier.
   *
   * The handshake below fires on a timer, and a timer that captured
   * `sendContent` when the iframe loaded would keep resending the document as it
   * was then — the preview would settle on a stale copy and stay there. Reading
   * through a ref means every attempt carries what the editor holds now.
   */
  useEffect(() => {
    sendCurrentRef.current = () => {
      sendContent();
      sendNavigation("auto");
    };
  }, [sendContent, sendNavigation]);

  /**
   * Gets the working document into a freshly loaded preview.
   *
   * This channel has no delivery guarantee: the preview starts listening only
   * once its client has mounted, and anything posted before that is dropped
   * silently, with nothing to retry it. That was survivable while the iframe
   * mounted with the editor and the operator's next keystroke resent the
   * document anyway. It is not survivable now: ESZ-156 mounts the preview on
   * demand — entering the preview mode on a phone — where there is no next
   * keystroke, and a burst of edits made while the iframe is still loading can
   * leave the preview pinned to the document it started with.
   *
   * So the editor keeps offering the document until the preview says it is
   * listening, and stops immediately when it does — usually on the first ping,
   * before a single repeat is needed. It is the same content message either way:
   * no second rendering path, and nothing the preview may display changes.
   */
  const startPreviewHandshake = useCallback(() => {
    previewAcknowledgedRef.current = false;
    window.clearInterval(handshakeIntervalRef.current);

    let attempts = 0;
    handshakeIntervalRef.current = window.setInterval(() => {
      attempts += 1;
      if (previewAcknowledgedRef.current || attempts > HANDSHAKE_ATTEMPTS) {
        window.clearInterval(handshakeIntervalRef.current);
        return;
      }
      sendCurrentRef.current();
    }, HANDSHAKE_INTERVAL_MS);

    sendCurrentRef.current();
  }, []);

  /** The preview is listening: answer once, and stop offering. */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const result = parseAdminPreviewReadyMessage(
        event,
        window.location.origin,
        iframeRef.current?.contentWindow,
      );
      if (result.status !== "accepted") return;
      previewAcknowledgedRef.current = true;
      sendCurrentRef.current();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  useEffect(
    () => () => {
      window.clearInterval(handshakeIntervalRef.current);
    },
    [],
  );

  useEffect(() => {
    sendContent();
    sendNavigation("auto");
  }, [sendContent, sendNavigation, mode]);

  useEffect(() => {
    sendNavigation("smooth");
  }, [sendNavigation]);

  const scaledWidth = Math.ceil(dimensions.width * scale);
  const scaledHeight = Math.ceil(logicalFrameHeight * scale);

  return (
    <div className="flex h-full min-h-[620px] flex-col gap-4">
      <div className="admin-panel flex flex-col gap-3 rounded-2xl p-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div>
          <h2 className="admin-text font-display text-2xl font-normal">
            Aperçu en direct
          </h2>
          <p className="admin-text-muted text-sm">
            Le contenu temporaire est envoyé à une iframe protégée et n&apos;est
            pas persisté.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Mode d’aperçu"
          className="admin-segmented grid w-full max-w-sm grid-cols-3 rounded-full p-1">
          {(["phone", "tablet", "desktop"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              role="tab"
              aria-selected={mode === nextMode}
              onClick={() => setMode(nextMode)}
              className="admin-segmented-option h-10 min-w-0 rounded-full px-2 text-center text-sm leading-none transition focus:outline-none focus:ring-2 focus:ring-sage-300">
              <span className="block truncate whitespace-nowrap">
                {PREVIEW_DIMENSIONS[nextMode].label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div
        ref={frameAreaRef}
        className="admin-muted-surface admin-border flex min-h-[520px] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border p-3 sm:p-4">
        <div
          className="relative"
          style={{
            width: scaledWidth,
            height: scaledHeight,
          }}>
          <div
            className={`absolute left-0 top-0 origin-top-left overflow-hidden bg-white ${
              mode === "phone"
                ? "rounded-[1.75rem] shadow-[0_0_0_6px_rgba(44,43,40,0.82),0_18px_60px_rgba(44,43,40,0.18)]"
                : mode === "tablet"
                  ? "rounded-[1.6rem] shadow-[0_0_0_6px_rgba(58,57,55,0.74),0_18px_60px_rgba(44,43,40,0.14)]"
                  : "rounded-2xl shadow-[0_0_0_1px_rgba(211,209,205,0.9),0_18px_60px_rgba(44,43,40,0.12)]"
            }`}
            style={{
              width: dimensions.width,
              height: logicalFrameHeight,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}>
            {mode !== "phone" && (
              <div className="flex h-8 items-center gap-1.5 border-b border-warm-200 bg-warm-100 px-3">
                <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src="/admin/preview"
              title="Aperçu en direct du site"
              width={dimensions.width}
              height={dimensions.height}
              onLoad={startPreviewHandshake}
              tabIndex={-1}
              scrolling="no"
              className="pointer-events-none block select-none border-0 bg-warm-50"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
