import type { CSSProperties } from "react";
import {
  createAppearanceCustomProperties,
  defaultSiteAppearance,
  hexColorSchema,
  siteAppearanceSchema,
  type SiteAppearance,
} from "@eszter/contracts";

type SiteAppearanceVariables = CSSProperties & Record<`--site-${string}`, string>;

/**
 * The `--site-*` properties, as an inline style object.
 *
 * The list, the order and the one derived value (`--site-primary-contrast`) come
 * from `@eszter/contracts`, which also generates them into
 * `contracts/generated/http-contract.json` for the PHP injector to read. Both
 * emitters are therefore driven by one declaration instead of two lists that have
 * to be kept in step by hand.
 *
 * The per-section blends this used to compute — `mixHexColors(background, tint,
 * 0.18)` and its eight siblings — moved into `globals.css` as `color-mix(in srgb,
 * …)`, which is the same gamma-space sRGB interpolation. That is what lets PHP
 * inject appearance at all: the injector now only ever copies hex values that
 * already passed `hexColorSchema`, and never has to reproduce a blending formula.
 */
export function createSiteAppearanceVariables(
  appearance: SiteAppearance,
): SiteAppearanceVariables {
  return Object.fromEntries(
    createAppearanceCustomProperties(appearance).map((property) => [
      property.name,
      property.value,
    ]),
  ) as SiteAppearanceVariables;
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
