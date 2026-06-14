import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSiteAppearance,
  defaultSiteContent,
  galleryItemIds,
  getContrastRatio,
  getReadableForeground,
  getRelativeLuminance,
  hexColorSchema,
  hexToRgb,
  mediaAssetIds,
  mixHexColors,
  navigationLinkIds,
  processStepIds,
  reassuranceItemIds,
  serviceItemIds,
  siteAppearanceSchema,
  siteContentSchema,
} from "@eszter/contracts";

const mojibakePattern = /Ã|Â|â(?:€|†|€™|€œ)|�/;

function legacyContent() {
  const legacy = { ...defaultSiteContent };
  delete (legacy as Partial<typeof defaultSiteContent>).appearance;
  return legacy;
}

test("canonical default content contains no mojibake and keeps corrected French strings", () => {
  const serialized = JSON.stringify(defaultSiteContent);

  assert.equal(mojibakePattern.test(serialized), false);
  for (const expected of [
    "Réalisations",
    "À propos",
    "pensé",
    "révéler",
    "Découvrir les prestations",
    "Résultat naturel",
    "Hygiène et précision",
    "Lèvres",
    "Échange et analyse",
    "Tous droits réservés.",
  ]) {
    assert.match(serialized, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("canonical default content preserves stable ids, lengths and schema validity", () => {
  assert.deepEqual(
    defaultSiteContent.navigation.links.map((link) => link.id),
    [...navigationLinkIds],
  );
  assert.deepEqual(
    defaultSiteContent.reassurance.items.map((item) => item.id),
    [...reassuranceItemIds],
  );
  assert.deepEqual(
    defaultSiteContent.services.items.map((item) => item.id),
    [...serviceItemIds],
  );
  assert.deepEqual(
    defaultSiteContent.process.steps.map((step) => step.id),
    [...processStepIds],
  );
  assert.deepEqual(
    defaultSiteContent.gallery.items.map((item) => item.id),
    [...galleryItemIds],
  );

  const actualMediaIds = [
    defaultSiteContent.hero.visual.id,
    ...defaultSiteContent.services.items.map((item) => item.visual.id),
    ...defaultSiteContent.gallery.items.map((item) => item.visual.id),
    defaultSiteContent.about.portrait.id,
  ];
  assert.deepEqual(actualMediaIds, [...mediaAssetIds]);

  assert.equal(defaultSiteContent.navigation.links.length, navigationLinkIds.length);
  assert.equal(defaultSiteContent.reassurance.items.length, reassuranceItemIds.length);
  assert.equal(defaultSiteContent.services.items.length, serviceItemIds.length);
  assert.equal(defaultSiteContent.process.steps.length, processStepIds.length);
  assert.equal(defaultSiteContent.gallery.items.length, galleryItemIds.length);
  assert.equal(siteContentSchema.safeParse(defaultSiteContent).success, true);
});

test("appearance schema validates canonical defaults and normalizes colors", () => {
  const parsed = siteAppearanceSchema.parse(defaultSiteAppearance);
  assert.deepEqual(parsed, defaultSiteAppearance);
  assert.equal(hexColorSchema.parse("#fafaf8"), "#FAFAF8");
  assert.equal(siteAppearanceSchema.safeParse(defaultSiteAppearance).success, true);
});

test("appearance schema rejects unsafe colors and unknown fields", () => {
  for (const invalid of ["#FFF", "#FFFFFFFF", "red", "rgb(0,0,0)", "var(--x)", "linear-gradient(red, blue)"]) {
    assert.equal(hexColorSchema.safeParse(invalid).success, false);
  }

  assert.equal(
    siteAppearanceSchema.safeParse({
      ...defaultSiteAppearance,
      palette: { ...defaultSiteAppearance.palette, extra: "#FFFFFF" },
    }).success,
    false,
  );
});

test("appearance compatibility accepts missing appearance and rejects partial appearance", () => {
  const parsed = siteContentSchema.parse(legacyContent());
  assert.deepEqual(parsed.appearance, defaultSiteAppearance);
  assert.deepEqual(siteContentSchema.parse(defaultSiteContent), defaultSiteContent);

  assert.equal(
    siteContentSchema.safeParse({
      ...legacyContent(),
      appearance: { palette: defaultSiteAppearance.palette },
    }).success,
    false,
  );
});

test("appearance contrast validation rejects low contrast and accepts muted minimum", () => {
  assert.equal(
    siteAppearanceSchema.safeParse({
      ...defaultSiteAppearance,
      palette: {
        ...defaultSiteAppearance.palette,
        text: "#F5F4F1",
      },
    }).success,
    false,
  );

  assert.equal(
    siteAppearanceSchema.safeParse({
      ...defaultSiteAppearance,
      palette: {
        ...defaultSiteAppearance.palette,
        surface: "#2C2B28",
      },
    }).success,
    false,
  );

  assert.equal(
    siteAppearanceSchema.safeParse({
      ...defaultSiteAppearance,
      palette: {
        ...defaultSiteAppearance.palette,
        mutedText: "#6D6B67",
      },
    }).success,
    true,
  );
});

test("color utilities are deterministic and CSS-safe", () => {
  assert.deepEqual(hexToRgb("#FAFAF8"), { r: 250, g: 250, b: 248 });
  assert.equal(Number(getRelativeLuminance("#000000").toFixed(4)), 0);
  assert.equal(getContrastRatio("#000000", "#FFFFFF") > 20, true);
  assert.equal(getReadableForeground("#63726C"), "#FFFFFF");
  assert.equal(getReadableForeground("#FAFAF8"), "#1D1C1A");
  assert.equal(mixHexColors("#F5F4F1", "#63726C", 0.2), "#D8DAD6");
  assert.equal(mixHexColors("#F5F4F1", "#63726C", 0.2), "#D8DAD6");
  assert.doesNotMatch(mixHexColors("#F5F4F1", "#63726C", 0.2), /[();]/);
});
