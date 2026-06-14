import {
  defaultSiteAppearance,
  siteAppearanceSchema,
  type HexColor,
  type SiteAppearance,
  type SiteContent,
} from "@eszter/contracts";

export type AppearanceEditResult =
  | { ok: true; content: SiteContent }
  | { ok: false; message: string };

function firstAppearanceError(candidate: SiteAppearance): string {
  const result = siteAppearanceSchema.safeParse(candidate);
  return result.success
    ? ""
    : (result.error.issues[0]?.message ??
        "Les couleurs sélectionnées ne respectent pas les contraintes de lisibilité.");
}

function commitAppearance(
  content: SiteContent,
  appearance: SiteAppearance,
): AppearanceEditResult {
  const message = firstAppearanceError(appearance);
  if (message) return { ok: false, message };
  return { ok: true, content: { ...content, appearance } };
}

export function updateGlobalPaletteColor(
  content: SiteContent,
  key: keyof SiteAppearance["palette"],
  value: HexColor,
): AppearanceEditResult {
  return commitAppearance(content, {
    ...content.appearance,
    palette: { ...content.appearance.palette, [key]: value },
  });
}

export function updateSectionTint(
  content: SiteContent,
  key: keyof SiteAppearance["sectionTints"],
  value: HexColor,
): AppearanceEditResult {
  return commitAppearance(content, {
    ...content.appearance,
    sectionTints: { ...content.appearance.sectionTints, [key]: value },
  });
}

export function resetGlobalPalette(content: SiteContent): SiteContent {
  return {
    ...content,
    appearance: {
      ...content.appearance,
      palette: defaultSiteAppearance.palette,
    },
  };
}

export function resetSectionTints(content: SiteContent): SiteContent {
  return {
    ...content,
    appearance: {
      ...content.appearance,
      sectionTints: defaultSiteAppearance.sectionTints,
    },
  };
}
