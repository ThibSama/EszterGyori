import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import manifest from "../app/manifest";
import robots from "../app/robots";
import sitemap from "../app/sitemap";
import {
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
  SITE_URL,
  siteMetadata,
} from "../app/lib/metadata/site-metadata";

const appRoot = join(process.cwd(), "app");

test("public metadata uses the production canonical origin and French copy", () => {
  assert.equal(siteMetadata.metadataBase?.toString(), `${SITE_ORIGIN}/`);
  assert.deepEqual(siteMetadata.title, {
    default: SITE_TITLE,
    template: "%s | Eszter Gyori",
  });
  assert.equal(siteMetadata.description, SITE_DESCRIPTION);
  assert.deepEqual(siteMetadata.alternates, {
    canonical: SITE_URL,
  });
  assert.equal(siteMetadata.openGraph?.locale, "fr_FR");
  assert.equal(siteMetadata.openGraph?.url, SITE_URL);
  assert.equal(siteMetadata.openGraph?.siteName, "Eszter Gyori");
  assert.equal(siteMetadata.twitter?.card, "summary_large_image");
  assert.doesNotMatch(SITE_DESCRIPTION, /levres|Resultats|pres de Lille/);
});

test("public metadata references icons, manifest and social images", () => {
  assert.deepEqual(siteMetadata.manifest, "/manifest.webmanifest");
  assert.match(JSON.stringify(siteMetadata.icons), /\/icon\.svg/);
  assert.match(JSON.stringify(siteMetadata.icons), /\/apple-icon/);
  assert.match(JSON.stringify(siteMetadata.openGraph?.images), /\/opengraph-image/);
  assert.match(JSON.stringify(siteMetadata.twitter?.images), /\/opengraph-image/);

  assert.equal(existsSync(join(appRoot, "icon.svg")), true);
  assert.equal(existsSync(join(appRoot, "apple-icon.tsx")), true);
  assert.equal(existsSync(join(appRoot, "opengraph-image.tsx")), true);
});

test("manifest contains the public identity and valid local icon references", () => {
  const result = manifest();

  assert.equal(result.name, "Eszter Gyori — Maquillage permanent");
  assert.equal(result.short_name, "Eszter Gyori");
  assert.equal(result.start_url, "/");
  assert.equal(result.display, "standalone");
  assert.equal(result.background_color, "#F5F4F1");
  assert.equal(result.theme_color, "#7E8D87");
  assert.equal(result.lang, "fr");
  assert.deepEqual(
    result.icons?.map((icon) => icon.src),
    ["/icon.svg", "/apple-icon"],
  );
});

test("robots and sitemap expose only the public page", () => {
  const robotsResult = robots();
  const sitemapResult = sitemap();

  assert.deepEqual(robotsResult.rules, [
    {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/"],
    },
  ]);
  assert.equal(robotsResult.sitemap, `${SITE_URL}sitemap.xml`);
  assert.deepEqual(sitemapResult.map((entry) => entry.url), [SITE_URL]);
  assert.doesNotMatch(JSON.stringify(sitemapResult), /admin|api|localhost/);
});

test("admin metadata remains noindex and no structured data is added", () => {
  const protectedLayoutSource = readFileSync(
    join(appRoot, "admin", "(protected)", "layout.tsx"),
    "utf8",
  );
  const loginSource = readFileSync(join(appRoot, "admin", "login", "page.tsx"), "utf8");
  const previewSource = readFileSync(
    join(appRoot, "admin", "preview", "page.tsx"),
    "utf8",
  );
  const layoutSource = readFileSync(join(appRoot, "layout.tsx"), "utf8");

  assert.match(protectedLayoutSource, /PRIVATE_ROBOTS/);
  assert.match(loginSource, /PRIVATE_ROBOTS/);
  assert.match(previewSource, /PRIVATE_ROBOTS/);
  assert.doesNotMatch(layoutSource, /application\/ld\+json|LocalBusiness|BeautySalon|openingHours|telephone/);
});

test("metadata sources do not contain placeholder or preview domains", () => {
  const source = [
    "layout.tsx",
    "manifest.ts",
    "robots.ts",
    "sitemap.ts",
    join("lib", "metadata", "site-metadata.ts"),
  ]
    .map((filePath) => readFileSync(join(appRoot, filePath), "utf8"))
    .join("\n");

  assert.doesNotMatch(source, /api\.example\.com|localhost|vercel\.app\/[^"']+-/);
});
