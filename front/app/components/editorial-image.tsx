"use client";

import { useState, type ReactNode } from "react";

export function shouldRenderEditorialImage(
  src: string | null,
  failedSource: string | null,
): src is string {
  return src !== null && src.trim().length > 0 && failedSource !== src;
}

export function EditorialImage({
  src,
  alt,
  surface,
  loading = "lazy",
  fetchPriority,
  className,
  fallback,
}: {
  src: string | null;
  alt: string;
  surface: string;
  loading?: "eager" | "lazy";
  fetchPriority?: "high" | "low" | "auto";
  className: string;
  fallback: ReactNode;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!shouldRenderEditorialImage(src, failedSource)) {
    return (
      <div
        data-editorial-media-fallback={surface}
        className="absolute inset-0">
        {fallback}
      </div>
    );
  }

  return (
    // Editorial media are runtime URLs owned by the CMS, not build-time assets.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-editorial-media={surface}
      src={src}
      alt={alt}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding="async"
      onError={() => setFailedSource(src)}
      className={className}
    />
  );
}
