"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAdminPreviewContentMessage,
  createAdminPreviewNavigationMessage,
} from "../../lib/admin-preview-messaging";
import type { AdminPreviewSectionKey } from "../../lib/admin-preview-sections";
import type { SiteContent } from "../../types/site-content";

type PreviewMode = "phone" | "tablet" | "desktop";

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
      <div className="flex flex-col gap-3 rounded-2xl border border-warm-300/70 bg-white/80 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.08)] 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div>
          <h2 className="font-display text-2xl font-normal text-warm-800">
            Aperçu en direct
          </h2>
          <p className="text-sm text-warm-500">
            Le contenu temporaire est envoyé à une iframe protégée et n&apos;est
            pas persisté.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Mode d’aperçu"
          className="grid w-full max-w-sm grid-cols-3 rounded-full border border-warm-300 bg-warm-100/70 p-1">
          {(["phone", "tablet", "desktop"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              role="tab"
              aria-selected={mode === nextMode}
              onClick={() => setMode(nextMode)}
              className={`h-10 min-w-0 rounded-full px-2 text-center text-sm font-medium leading-none transition focus:outline-none focus:ring-2 focus:ring-sage-300 ${
                mode === nextMode
                  ? "bg-warm-800 text-porcelain shadow-sm"
                  : "text-warm-600 hover:bg-white/80 hover:text-warm-900"
              }`}>
              <span className="block truncate whitespace-nowrap">
                {PREVIEW_DIMENSIONS[nextMode].label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div
        ref={frameAreaRef}
        className="flex min-h-[520px] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-warm-200/80 bg-warm-100/55 p-3 sm:p-4">
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
              onLoad={() => {
                sendContent();
                sendNavigation("auto");
              }}
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
