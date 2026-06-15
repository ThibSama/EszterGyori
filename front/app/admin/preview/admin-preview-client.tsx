"use client";

import { useEffect, useState } from "react";
import { SitePreview } from "../../components/site-preview";
import {
  parseAdminPreviewContentMessage,
  parseAdminPreviewNavigationMessage,
} from "../../lib/admin-preview-messaging";
import {
  ADMIN_PREVIEW_SECTION_BY_KEY,
  type AdminPreviewSectionKey,
} from "../../lib/admin-preview-sections";
import type { SiteContent } from "../../types/site-content";

export function AdminPreviewClient({
  defaultContent,
}: {
  defaultContent: SiteContent;
}) {
  const [content, setContent] = useState(defaultContent);
  const [activeSection, setActiveSection] =
    useState<AdminPreviewSectionKey>("hero");
  const [navigationRequest, setNavigationRequest] = useState<{
    section: AdminPreviewSectionKey;
    behavior: ScrollBehavior;
    version: number;
  }>({ section: "hero", behavior: "auto", version: 0 });

  function scrollPreviewToSection(
    sectionKey: AdminPreviewSectionKey,
    behavior: ScrollBehavior,
  ) {
    const section = ADMIN_PREVIEW_SECTION_BY_KEY.get(sectionKey);
    if (!section) return;

    const target = document.querySelector<HTMLElement>(
      `[data-preview-section="${section.previewTarget}"]`,
    );
    if (!target) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `Admin preview section target not found: ${section.previewTarget}`,
        );
      }
      return;
    }

    const header = document.querySelector<HTMLElement>("nav");
    const headerOffset =
      section.previewAlignment === "top"
        ? 0
        : Math.ceil((header?.getBoundingClientRect().height ?? 0) + 24);
    const documentHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const currentTop = window.scrollY;
    const targetRect = target.getBoundingClientRect();
    const rawTop =
      section.previewAlignment === "end"
        ? currentTop + targetRect.bottom - viewportHeight + 24
        : currentTop + targetRect.top - headerOffset;
    const targetTop = Math.max(
      0,
      Math.min(rawTop, Math.max(0, documentHeight - viewportHeight)),
    );
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    window.scrollTo({
      top: targetTop,
      behavior: prefersReducedMotion ? "auto" : behavior,
    });
  }

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const contentResult = parseAdminPreviewContentMessage(
        event,
        window.location.origin,
        window.parent,
      );

      if (contentResult.status === "accepted") {
        setContent(contentResult.content);
        return;
      }

      const navigationResult = parseAdminPreviewNavigationMessage(
        event,
        window.location.origin,
        window.parent,
      );

      if (navigationResult.status === "accepted") {
        setActiveSection(navigationResult.section);
        setNavigationRequest((current) => ({
          section: navigationResult.section,
          behavior: navigationResult.behavior,
          version: current.version + 1,
        }));
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  useEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        scrollPreviewToSection(
          navigationRequest.section,
          navigationRequest.behavior,
        );
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [navigationRequest]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      scrollPreviewToSection(activeSection, "auto");
    }, 80);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [content, activeSection]);

  return <SitePreview content={content} disableRevealAnimations />;
}
