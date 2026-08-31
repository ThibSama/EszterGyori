import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "./lib/metadata/site-metadata";

/**
 * Emitted as a file by `next build`, not by a request handler.
 *
 * `output: "export"` requires every metadata route to say so explicitly: without
 * it the build stops rather than shipping a route that would need Node on a host
 * that has none. This output depends on nothing per-request, so pinning it is a
 * statement of fact (`docs/hetzner-target-architecture.md` §2).
 */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Eszter Gyori — Maquillage permanent",
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#F5F4F1",
    theme_color: "#7E8D87",
    lang: "fr",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
