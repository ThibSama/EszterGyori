import "server-only";

import type { SiteContent } from "@eszter/contracts";
import { defaultSiteContent } from "@eszter/contracts";
import { publishedContentEnvelopeV1Schema } from "@eszter/contracts";

const CONTENT_API_TIMEOUT_MS = 3_000;
const CONTENT_REVALIDATE_SECONDS = 60;

type PublicContentSource = "api" | "default";

type FallbackReason =
  | "CONTENT_API_NOT_CONFIGURED"
  | "CONTENT_API_INVALID_URL"
  | "CONTENT_API_TIMEOUT"
  | "CONTENT_API_NETWORK_FAILURE"
  | "CONTENT_API_HTTP_FAILURE"
  | "CONTENT_API_INVALID_JSON"
  | "CONTENT_API_VALIDATION_FAILURE"
  | "CONTENT_API_UNEXPECTED_FAILURE";

export interface PublicContentResult {
  content: SiteContent;
  source: PublicContentSource;
  revision: number | null;
  publishedAt: string | null;
}

export async function loadPublicSiteContent(): Promise<PublicContentResult> {
  const endpoint = getConfiguredContentEndpoint();

  if (!endpoint.ok) {
    logContentFallback(endpoint.reason);
    return createDefaultResult();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTENT_API_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      credentials: "omit",
      signal: controller.signal,
      next: {
        revalidate: CONTENT_REVALIDATE_SECONDS,
      },
    });

    if (!response.ok) {
      logContentFallback("CONTENT_API_HTTP_FAILURE", {
        hostname: endpoint.hostname,
        status: response.status,
      });
      return createDefaultResult();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      logContentFallback("CONTENT_API_INVALID_JSON", {
        hostname: endpoint.hostname,
      });
      return createDefaultResult();
    }

    const envelope = publishedContentEnvelopeV1Schema.safeParse(body);
    if (!envelope.success) {
      logContentFallback("CONTENT_API_VALIDATION_FAILURE", {
        hostname: endpoint.hostname,
      });
      return createDefaultResult();
    }

    return {
      content: envelope.data.content,
      source: "api",
      revision: envelope.data.revision,
      publishedAt: envelope.data.publishedAt,
    };
  } catch (error) {
    if (isAbortError(error)) {
      logContentFallback("CONTENT_API_TIMEOUT", {
        hostname: endpoint.hostname,
      });
      return createDefaultResult();
    }

    logContentFallback("CONTENT_API_NETWORK_FAILURE", {
      hostname: endpoint.hostname,
    });
    return createDefaultResult();
  } finally {
    clearTimeout(timeout);
  }
}

function getConfiguredContentEndpoint():
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: FallbackReason } {
  const rawUrl = process.env.CONTENT_API_URL;
  if (rawUrl === undefined) {
    return { ok: false, reason: "CONTENT_API_NOT_CONFIGURED" };
  }

  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    return { ok: false, reason: "CONTENT_API_INVALID_URL" };
  }

  try {
    const url = new URL(trimmedUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "CONTENT_API_INVALID_URL" };
    }

    return {
      ok: true,
      url: url.toString(),
      hostname: url.hostname,
    };
  } catch {
    return { ok: false, reason: "CONTENT_API_INVALID_URL" };
  }
}

function createDefaultResult(): PublicContentResult {
  return {
    content: defaultSiteContent,
    source: "default",
    revision: null,
    publishedAt: null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function logContentFallback(
  reason: FallbackReason,
  details: { hostname?: string; status?: number } = {},
): void {
  console.warn("Public content fallback", {
    reason,
    ...details,
  });
}
