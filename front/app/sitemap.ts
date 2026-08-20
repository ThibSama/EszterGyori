import type { MetadataRoute } from "next";
import { SITE_URL } from "./lib/metadata/site-metadata";

/**
 * Emitted as a file by `next build`, not by a request handler.
 *
 * `output: "export"` requires every metadata route to say so explicitly: without
 * it the build stops rather than shipping a route that would need Node on a host
 * that has none. This output depends on nothing per-request, so pinning it is a
 * statement of fact (`docs/hetzner-target-architecture.md` §2).
 */
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
