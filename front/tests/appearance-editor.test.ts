import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  defaultSiteAppearance,
  defaultSiteContent,
} from "@eszter/contracts";
import {
  resetGlobalPalette,
  resetSectionTints,
  updateGlobalPaletteColor,
  updateSectionTint,
} from "../app/lib/admin-appearance-editor";
import {
  parseAdminPreviewContentMessage,
  createAdminPreviewContentMessage,
} from "../app/lib/admin-preview-messaging";
import { createCompleteResetState } from "../app/lib/admin-content-reset";
import { parseDraft, serializeDraft } from "../app/lib/admin-draft-storage";

function customContent() {
  return {
    ...defaultSiteContent,
    appearance: {
      palette: {
        ...defaultSiteAppearance.palette,
        background: "#F0F1F4",
        primary: "#3D4845",
      },
      sectionTints: {
        ...defaultSiteAppearance.sectionTints,
        hero: "#CDD1D8",
      },
    },
  };
}

test("appearance editor updates global palette and section tints", () => {
  const paletteResult = updateGlobalPaletteColor(
    defaultSiteContent,
    "primary",
    "#3D4845",
  );
  assert.equal(paletteResult.ok, true);
  if (paletteResult.ok) {
    assert.equal(paletteResult.content.appearance.palette.primary, "#3D4845");
  }

  const tintResult = updateSectionTint(defaultSiteContent, "services", "#CDD1D8");
  assert.equal(tintResult.ok, true);
  if (tintResult.ok) {
    assert.equal(tintResult.content.appearance.sectionTints.services, "#CDD1D8");
  }
});

test("appearance subsection resets preserve unrelated content and settings", () => {
  const content = customContent();
  const paletteReset = resetGlobalPalette(content);
  assert.deepEqual(paletteReset.appearance.palette, defaultSiteAppearance.palette);
  assert.equal(paletteReset.appearance.sectionTints.hero, "#CDD1D8");
  assert.equal(paletteReset.navigation.brandLabel, defaultSiteContent.navigation.brandLabel);

  const tintReset = resetSectionTints(content);
  assert.equal(tintReset.appearance.palette.primary, "#3D4845");
  assert.deepEqual(tintReset.appearance.sectionTints, defaultSiteAppearance.sectionTints);
});

test("complete reset restores canonical appearance", () => {
  const result = createCompleteResetState(defaultSiteContent, { ok: true });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.state.content.appearance, defaultSiteAppearance);
  }
});

test("local draft round-trip preserves appearance and legacy drafts receive defaults", () => {
  const parsed = parseDraft(serializeDraft(customContent()));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.draft.content.appearance, customContent().appearance);
  }

  const legacyContent = { ...defaultSiteContent };
  delete (legacyContent as Partial<typeof defaultSiteContent>).appearance;
  const legacyDraft = JSON.stringify({
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    savedAt: "2026-06-14T12:00:00.000Z",
    content: legacyContent,
  });
  const legacyParsed = parseDraft(legacyDraft);
  assert.equal(legacyParsed.ok, true);
  if (legacyParsed.ok) {
    assert.deepEqual(legacyParsed.draft.content.appearance, defaultSiteAppearance);
  }
});

test("JSON export contains appearance and invalid appearance import fails", () => {
  assert.match(serializeDraft(defaultSiteContent), /"appearance"/);

  const invalidDraft = JSON.stringify({
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    savedAt: "2026-06-14T12:00:00.000Z",
    content: {
      ...defaultSiteContent,
      appearance: {
        ...defaultSiteAppearance,
        palette: { ...defaultSiteAppearance.palette, text: "#F5F4F1" },
      },
    },
  });
  const parsed = parseDraft(invalidDraft);
  assert.equal(parsed.ok, false);
});

test("preview messages carry and validate appearance inside SiteContent", () => {
  const content = customContent();
  const message = createAdminPreviewContentMessage(content);
  assert.deepEqual(message.content.appearance, content.appearance);
  assert.deepEqual(Object.keys(message).sort(), ["content", "type"]);

  const accepted = parseAdminPreviewContentMessage(
    { data: message, origin: "https://eszter.example", source: windowLike },
    "https://eszter.example",
    windowLike,
  );
  assert.equal(accepted.status, "accepted");

  const rejected = parseAdminPreviewContentMessage(
    {
      data: {
        ...message,
        content: {
          ...content,
          appearance: {
            ...content.appearance,
            palette: { ...content.appearance.palette, background: "red" },
          },
        },
      },
      origin: "https://eszter.example",
      source: windowLike,
    },
    "https://eszter.example",
    windowLike,
  );
  assert.equal(rejected.status, "rejected");
});

const windowLike = { name: "parent" };
