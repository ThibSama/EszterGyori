"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAdminPreviewContentMessage } from "../../lib/admin-preview-messaging";
import type { SiteContent } from "../../types/site-content";

type PreviewMode = "phone" | "desktop";

const PREVIEW_DIMENSIONS: Record<
  PreviewMode,
  { label: string; width: number; height: number }
> = {
  phone: { label: "Téléphone", width: 390, height: 820 },
  desktop: { label: "Ordinateur", width: 1280, height: 860 },
};

export function AdminPreviewViewport({ content }: { content: SiteContent }) {
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const [availableWidth, setAvailableWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dimensions = PREVIEW_DIMENSIONS[mode];
  const framePadding = mode === "phone" ? 32 : 24;
  const scale =
    availableWidth > 0
      ? Math.min(1, Math.max(0.25, (availableWidth - framePadding) / dimensions.width))
      : 1;

  const sendContent = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      createAdminPreviewContentMessage(content),
      window.location.origin,
    );
  }, [content]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setAvailableWidth(entry.contentRect.width);
    });
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    sendContent();
  }, [sendContent, mode]);

  const wrapperHeight = Math.ceil(dimensions.height * scale);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-warm-300/70 bg-white/80 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.08)] sm:flex-row sm:items-center sm:justify-between">
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
          className="inline-flex rounded-full border border-warm-300 bg-warm-100/70 p-1"
          aria-label="Mode d’aperçu">
          {(["phone", "desktop"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              aria-pressed={mode === nextMode}
              onClick={() => setMode(nextMode)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 ${
                mode === nextMode
                  ? "bg-warm-800 text-porcelain shadow-sm"
                  : "text-warm-600 hover:bg-white/80 hover:text-warm-900"
              }`}>
              {PREVIEW_DIMENSIONS[nextMode].label}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="min-w-0 overflow-hidden">
        <div
          className={`mx-auto overflow-hidden bg-white ${
            mode === "phone"
              ? "rounded-[2rem] border-[10px] border-warm-800/85 shadow-[0_18px_60px_rgba(44,43,40,0.18)]"
              : "rounded-2xl border border-warm-300/80 shadow-[0_18px_60px_rgba(44,43,40,0.12)]"
          }`}
          style={{
            width: dimensions.width * scale,
            height: wrapperHeight,
          }}>
          {mode === "desktop" && (
            <div className="flex h-8 items-center gap-1.5 border-b border-warm-200 bg-warm-100 px-3">
              <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-warm-300" />
            </div>
          )}
          <div
            className="origin-top-center"
            style={{
              width: dimensions.width,
              height: dimensions.height,
              transform: `scale(${scale})`,
              transformOrigin: "top center",
            }}>
            <iframe
              ref={iframeRef}
              src="/admin/preview"
              title="Aperçu en direct du site"
              width={dimensions.width}
              height={dimensions.height}
              onLoad={sendContent}
              className="block border-0 bg-warm-50"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
