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

/**
 * Encoding-corruption signatures, checked structurally rather than against editorial
 * copy. Asserting on specific sentences couples this suite to wording that is expected
 * to change; the invariant that must never change is that the canonical content is
 * well-formed, NFC-normalised UTF-8 that still carries its French diacritics.
 */
const mojibakePattern = /Ã|Â|â(?:€|†|€™|€œ)|�/;
const htmlEntityPattern = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{2,6}|#[Xx][0-9A-Fa-f]{2,6});/;
const literalUnicodeEscapePattern = /\\u[0-9A-Fa-f]{4}/;
const controlCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const accentedLatinPattern = /[\u00C0-\u024F]/;

/** Minimum diacritic density below which the content has plausibly been ASCII-flattened. */
const minAccentedOccurrences = 40;
const minDistinctAccentedCharacters = 5;
/** Accents no French copy of this size can plausibly lose. */
const requiredAccentedCharacters = ["é", "è", "à"];

/** Every string in the document, keyed by JSON Pointer, so a failure names its location. */
function collectStrings(value: unknown, pointer = "", into = new Map<string, string>()) {
  if (typeof value === "string") {
    into.set(pointer, value);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${pointer}/${index}`, into));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, into);
    }
  }
  return into;
}

function legacyContent() {
  const legacy = { ...defaultSiteContent };
  delete (legacy as Partial<typeof defaultSiteContent>).appearance;
  return legacy;
}

test("canonical default content is free of encoding corruption", () => {
  for (const [pointer, value] of collectStrings(defaultSiteContent)) {
    assert.equal(mojibakePattern.test(value), false, `mojibake sequence at ${pointer}: ${value}`);
    assert.equal(value.includes("\uFFFD"), false, `replacement character at ${pointer}: ${value}`);
    assert.equal(value.isWellFormed(), true, `lone surrogate at ${pointer}: ${value}`);
    assert.equal(value.normalize("NFC"), value, `string is not NFC-normalised at ${pointer}: ${value}`);
    assert.equal(controlCharPattern.test(value), false, `control character at ${pointer}: ${value}`);
    assert.equal(htmlEntityPattern.test(value), false, `HTML entity left unescaped at ${pointer}: ${value}`);
    assert.equal(
      literalUnicodeEscapePattern.test(value),
      false,
      `literal \\uXXXX escape at ${pointer}: ${value}`,
    );
  }
});

test("canonical default content survives a UTF-8 and JSON round trip unchanged", () => {
  const serialized = JSON.stringify(defaultSiteContent);

  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(serialized));
  assert.equal(decoded, serialized);
  assert.deepEqual(JSON.parse(serialized), defaultSiteContent);
});

test("canonical default content keeps its French diacritics", () => {
  const characters = [...JSON.stringify(defaultSiteContent)];
  const accented = characters.filter((character) => accentedLatinPattern.test(character));

  assert.ok(
    accented.length >= minAccentedOccurrences,
    `expected at least ${minAccentedOccurrences} accented characters, found ${accented.length} — content may have been ASCII-flattened`,
  );
  assert.ok(
    new Set(accented).size >= minDistinctAccentedCharacters,
    `expected at least ${minDistinctAccentedCharacters} distinct accented characters, found ${new Set(accented).size}`,
  );
  for (const required of requiredAccentedCharacters) {
    assert.ok(accented.includes(required), `expected French copy to still contain "${required}"`);
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
