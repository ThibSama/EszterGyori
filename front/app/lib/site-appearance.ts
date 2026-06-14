import type { CSSProperties } from "react";
import {
  defaultSiteAppearance,
  getReadableForeground,
  hexColorSchema,
  mixHexColors,
  siteAppearanceSchema,
  type SiteAppearance,
} from "@eszter/contracts";

type SiteAppearanceVariables = CSSProperties & Record<`--site-${string}`, string>;

export function createSiteAppearanceVariables(
  appearance: SiteAppearance,
): SiteAppearanceVariables {
  const palette = appearance.palette;
  const tints = appearance.sectionTints;
  const background = palette.background;

  return {
    "--site-background": palette.background,
    "--site-surface": palette.surface,
    "--site-text": palette.text,
    "--site-muted-text": palette.mutedText,
    "--site-primary": palette.primary,
    "--site-primary-contrast": getReadableForeground(palette.primary),
    "--site-secondary": palette.secondary,
    "--site-warm-accent": palette.warmAccent,
    "--site-section-navigation": mixHexColors(background, tints.navigation, 0.16),
    "--site-section-hero": mixHexColors(background, tints.hero, 0.2),
    "--site-section-reassurance": mixHexColors(background, tints.reassurance, 0.18),
    "--site-section-services": mixHexColors(background, tints.services, 0.18),
    "--site-section-process": mixHexColors(background, tints.process, 0.22),
    "--site-section-gallery": mixHexColors(background, tints.gallery, 0.16),
    "--site-section-about": mixHexColors(background, tints.about, 0.2),
    "--site-section-contact": mixHexColors(background, tints.contact, 0.18),
    "--site-section-footer": mixHexColors(background, tints.footer, 0.22),
  };
}

export function normalizeEditableHexColor(value: string): string | null {
  const result = hexColorSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function getAppearanceValidationMessage(
  appearance: SiteAppearance,
): string | null {
  const result = siteAppearanceSchema.safeParse(appearance);
  if (result.success) return null;
  return (
    result.error.issues[0]?.message ??
    "Les couleurs sélectionnées ne respectent pas les contraintes de lisibilité."
  );
}

export { defaultSiteAppearance };
