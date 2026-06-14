"use client";

import { useEffect, useState } from "react";
import { SitePreview } from "../../components/site-preview";
import { parseAdminPreviewContentMessage } from "../../lib/admin-preview-messaging";
import type { SiteContent } from "../../types/site-content";

export function AdminPreviewClient({
  defaultContent,
}: {
  defaultContent: SiteContent;
}) {
  const [content, setContent] = useState(defaultContent);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const result = parseAdminPreviewContentMessage(
        event,
        window.location.origin,
        window.parent,
      );

      if (result.status === "accepted") {
        setContent(result.content);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  return <SitePreview content={content} disableRevealAnimations />;
}
