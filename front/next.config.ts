import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ESZ-020 — the frontend is a static export.
 *
 * `output: "export"` is the whole migration in one line, and it is load-bearing
 * rather than cosmetic: it makes the build *refuse* anything that would need a
 * Node process in production. Middleware, route handlers, `revalidate`, dynamic
 * server rendering and `next/image` optimisation all become build errors instead
 * of things that quietly work here and cannot work on Hetzner
 * (`docs/hetzner-target-architecture.md` §2: Node is a build-time toolchain only).
 *
 * That is why the removal of `proxy.ts`, `app/admin/auth/*` and
 * `app/lib/{auth,server}` is not merely tidying — with this flag set, keeping any
 * of them would fail `next build`.
 */
const nextConfig: NextConfig = {
  output: "export",

  // Fixed once here and matched by the `.htaccess` rewrite rules
  // (`docs/hetzner-target-architecture.md` §12). Disagreement between the two is
  // what produces redirect loops that only appear in production, so the export
  // emits `admin/index.html` and Apache rewrites `/admin` to it, with no
  // canonicalising redirect in between.
  trailingSlash: false,

  images: {
    // There is no image optimiser on the target host. Declaring it here means an
    // unoptimisable `next/image` fails the build rather than 404-ing in
    // production.
    unoptimized: true,
  },

  experimental: {
    externalDir: true,
  },
  turbopack: {
    root: projectRoot,
  },
  transpilePackages: ["@eszter/contracts"],
};

export default nextConfig;
