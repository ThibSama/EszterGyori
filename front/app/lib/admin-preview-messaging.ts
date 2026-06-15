import { siteContentSchema, type SiteContent } from "@eszter/contracts";
import {
  ADMIN_PREVIEW_NAVIGATION_MESSAGE,
  type AdminPreviewScrollAlignment,
  type AdminPreviewSectionKey,
  isAdminPreviewSectionKey,
} from "./admin-preview-sections";

export const ADMIN_PREVIEW_CONTENT_MESSAGE = "ESZTER_ADMIN_PREVIEW_CONTENT";

export interface AdminPreviewContentMessage {
  type: typeof ADMIN_PREVIEW_CONTENT_MESSAGE;
  content: SiteContent;
}

export interface AdminPreviewNavigationMessage {
  type: typeof ADMIN_PREVIEW_NAVIGATION_MESSAGE;
  section: AdminPreviewSectionKey;
  behavior: ScrollBehavior;
}

type PreviewMessageStatus = "accepted" | "ignored" | "rejected";

export type PreviewMessageResult =
  | { status: "accepted"; content: SiteContent }
  | { status: Exclude<PreviewMessageStatus, "accepted"> };

export type PreviewNavigationMessageResult =
  | {
      status: "accepted";
      section: AdminPreviewSectionKey;
      behavior: ScrollBehavior;
      alignment?: AdminPreviewScrollAlignment;
    }
  | { status: Exclude<PreviewMessageStatus, "accepted"> };

interface PreviewMessageLike {
  data: unknown;
  origin: string;
  source: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAdminPreviewContentMessage(
  content: SiteContent,
): AdminPreviewContentMessage {
  return {
    type: ADMIN_PREVIEW_CONTENT_MESSAGE,
    content,
  };
}

// Parent-to-preview messages are deliberately limited to validated content and
// known section keys. The iframe resolves keys locally and never executes
// arbitrary selectors or code received through postMessage.
export function createAdminPreviewNavigationMessage(
  section: AdminPreviewSectionKey,
  behavior: ScrollBehavior = "smooth",
): AdminPreviewNavigationMessage {
  return {
    type: ADMIN_PREVIEW_NAVIGATION_MESSAGE,
    section,
    behavior,
  };
}

export function parseAdminPreviewContentMessage(
  event: PreviewMessageLike,
  expectedOrigin: string,
  expectedSource: unknown,
): PreviewMessageResult {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) {
    return { status: "rejected" };
  }

  if (!isRecord(event.data)) {
    return { status: "ignored" };
  }

  if (event.data.type !== ADMIN_PREVIEW_CONTENT_MESSAGE) {
    return { status: "ignored" };
  }

  const result = siteContentSchema.safeParse(event.data.content);
  if (!result.success) {
    return { status: "rejected" };
  }

  return {
    status: "accepted",
    content: result.data,
  };
}

export function parseAdminPreviewNavigationMessage(
  event: PreviewMessageLike,
  expectedOrigin: string,
  expectedSource: unknown,
): PreviewNavigationMessageResult {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) {
    return { status: "rejected" };
  }

  if (!isRecord(event.data)) {
    return { status: "ignored" };
  }

  if (event.data.type !== ADMIN_PREVIEW_NAVIGATION_MESSAGE) {
    return { status: "ignored" };
  }

  if (!isAdminPreviewSectionKey(event.data.section)) {
    return { status: "rejected" };
  }

  const behavior =
    event.data.behavior === "auto" || event.data.behavior === "smooth"
      ? event.data.behavior
      : "auto";

  return {
    status: "accepted",
    section: event.data.section,
    behavior,
  };
}
