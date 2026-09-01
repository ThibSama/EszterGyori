import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { shouldRenderEditorialImage } from "../app/components/editorial-image";

const componentRoot = join(process.cwd(), "app", "components");
const imageSource = readFileSync(join(componentRoot, "editorial-image.tsx"), "utf8");
const siteSource = readFileSync(join(componentRoot, "site-preview.tsx"), "utf8");
const gallerySource = readFileSync(
  join(componentRoot, "site-gallery-section.tsx"),
  "utf8",
);

test("editorial images keep runtime URLs, alt text and load failure at one boundary", () => {
  assert.match(imageSource, /src=\{src\}/);
  assert.match(imageSource, /alt=\{alt\}/);
  assert.match(imageSource, /onError=\{\(\) => setFailedSource\(src\)\}/);
  assert.match(imageSource, /loading=\{loading\}/);
  assert.match(imageSource, /decoding="async"/);
  assert.match(imageSource, /data-editorial-media-fallback=\{surface\}/);
  assert.doesNotMatch(imageSource, /data:image|base64/);
});

test("null and failed sources select the explicit fallback deterministically", () => {
  assert.equal(shouldRenderEditorialImage(null, null), false);
  assert.equal(shouldRenderEditorialImage("/media/broken.webp", "/media/broken.webp"), false);
  assert.equal(shouldRenderEditorialImage("/media/working.webp", "/media/broken.webp"), true);
});

test("Hero, Services, Gallery and About pass their contracted source and alt", () => {
  assert.match(
    siteSource,
    /src=\{content\.visual\.src\}[\s\S]*alt=\{content\.visual\.alt\}[\s\S]*surface="hero"/,
  );
  assert.match(
    siteSource,
    /src=\{item\.visual\.src\}[\s\S]*alt=\{item\.visual\.alt\}[\s\S]*surface=\{`service-\$\{item\.id\}`\}/,
  );
  assert.match(
    gallerySource,
    /src=\{item\.visual\.src\}[\s\S]*alt=\{item\.visual\.alt\}[\s\S]*surface=\{`gallery-\$\{item\.id\}`\}/,
  );
  assert.match(
    siteSource,
    /src=\{content\.portrait\.src\}[\s\S]*alt=\{content\.portrait\.alt\}[\s\S]*surface="about"/,
  );
});

test("geometry is reserved and only Hero is fetched eagerly", () => {
  const combined = `${siteSource}\n${gallerySource}`;
  assert.equal((combined.match(/<EditorialImage/g) ?? []).length, 4);
  assert.equal((combined.match(/loading="eager"/g) ?? []).length, 1);
  assert.equal((combined.match(/fetchPriority="high"/g) ?? []).length, 1);
  assert.equal((combined.match(/object-cover/g) ?? []).length, 4);
  assert.match(siteSource, /aspect-\[3\/4\]/);
  assert.match(siteSource, /aspect-\[5\/3\]/);
  assert.match(gallerySource, /aspect-\[16\/9\][\s\S]*aspect-square/);
});
