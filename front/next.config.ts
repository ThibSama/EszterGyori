import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function productionBuildId(): string {
  const hash = createHash("sha256");
  const inputs = [
    "front/app",
    "front/public",
    "front/next.config.ts",
    "front/package.json",
    "front/package-lock.json",
    "front/postcss.config.mjs",
    "front/tsconfig.json",
    "contracts",
  ];

  const add = (relativePath: string): void => {
    const absolutePath = resolve(projectRoot, relativePath);
    const stat = lstatSync(absolutePath);
    hash.update(relativePath).update("\0");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) {
        if (["dist", "node_modules", "scripts", "tests"].includes(name)) continue;
        add(`${relativePath}/${name}`);
      }
      return;
    }
    hash.update(readFileSync(absolutePath)).update("\0");
  };

  for (const input of inputs) add(input);

  return hash.digest("hex").slice(0, 24);
}

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

  // Next otherwise generates a random build id, which makes byte-identical source
  // produce a different deployment archive. Hash only runtime build inputs: source
  // changes still bust the build-specific path, while repeated builds stay identical.
  generateBuildId: async () => productionBuildId(),

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
