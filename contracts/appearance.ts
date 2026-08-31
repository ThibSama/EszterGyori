import { z } from "zod";

export type HexColor = `#${string}`;

export const sitePaletteKeys = [
  "background",
  "surface",
  "text",
  "mutedText",
  "primary",
  "secondary",
  "warmAccent",
] as const;

export const siteSectionTintKeys = [
  "navigation",
  "hero",
  "reassurance",
  "services",
  "process",
  "gallery",
  "about",
  "contact",
  "footer",
] as const;

export const defaultSiteAppearance = {
  palette: {
    background: "#F5F4F1",
    surface: "#FAFAF8",
    text: "#2C2B28",
    mutedText: "#6D6B67",
    primary: "#63726C",
    secondary: "#A8AEB8",
    warmAccent: "#D3D1CD",
  },
  sectionTints: {
    navigation: "#FAFAF8",
    hero: "#DBE0DD",
    reassurance: "#DBE0DD",
    services: "#E0DEDB",
    process: "#DBE0DD",
    gallery: "#EDECE8",
    about: "#EDECE8",
    contact: "#E3E5EA",
    footer: "#EDECE8",
  },
} as const;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Doit être une couleur hexadécimale #RRGGBB.")
  .transform((value) => normalizeHexColor(value));

export function normalizeHexColor(value: string): HexColor {
  return value.toUpperCase() as HexColor;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hexColorSchema.parse(hex);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function linearizeColorChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

export function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (
    0.2126 * linearizeColorChannel(r) +
    0.7152 * linearizeColorChannel(g) +
    0.0722 * linearizeColorChannel(b)
  );
}

export function getContrastRatio(first: string, second: string): number {
  const lighter = Math.max(getRelativeLuminance(first), getRelativeLuminance(second));
  const darker = Math.min(getRelativeLuminance(first), getRelativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function getReadableForeground(background: string): HexColor {
  return getContrastRatio(background, "#FFFFFF") >=
    getContrastRatio(background, "#1D1C1A")
    ? "#FFFFFF"
    : "#1D1C1A";
}

export function mixHexColors(background: string, tint: string, ratio: number): HexColor {
  const safeRatio = Math.min(1, Math.max(0, ratio));
  const base = hexToRgb(background);
  const overlay = hexToRgb(tint);
  const mix = (baseChannel: number, tintChannel: number) =>
    Math.round(baseChannel * (1 - safeRatio) + tintChannel * safeRatio)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();

  return `#${mix(base.r, overlay.r)}${mix(base.g, overlay.g)}${mix(
    base.b,
    overlay.b,
  )}` as HexColor;
}

const paletteSchema = z
  .object(Object.fromEntries(sitePaletteKeys.map((key) => [key, hexColorSchema])) as {
    [Key in (typeof sitePaletteKeys)[number]]: typeof hexColorSchema;
  })
  .strict();

const sectionTintsSchema = z
  .object(Object.fromEntries(siteSectionTintKeys.map((key) => [key, hexColorSchema])) as {
    [Key in (typeof siteSectionTintKeys)[number]]: typeof hexColorSchema;
  })
  .strict();

export const siteAppearanceSchema = z
  .object({
    palette: paletteSchema,
    sectionTints: sectionTintsSchema,
  })
  .strict()
  .superRefine((appearance, context) => {
    const allColors = [
      ...Object.values(appearance.palette),
      ...Object.values(appearance.sectionTints),
    ];
    if (allColors.some((color) => !hexColorSchema.safeParse(color).success)) {
      return;
    }

    const checks = [
      {
        path: ["palette", "text"],
        ratio: getContrastRatio(appearance.palette.text, appearance.palette.background),
        minimum: 4.5,
        message: "Le texte principal doit rester lisible sur le fond général.",
      },
      {
        path: ["palette", "text"],
        ratio: getContrastRatio(appearance.palette.text, appearance.palette.surface),
        minimum: 4.5,
        message: "Le texte principal doit rester lisible sur les surfaces.",
      },
      {
        path: ["palette", "mutedText"],
        ratio: getContrastRatio(
          appearance.palette.mutedText,
          appearance.palette.background,
        ),
        minimum: 3,
        message: "Le texte secondaire doit rester lisible sur le fond général.",
      },
    ];

    checks.forEach((check) => {
      if (check.ratio < check.minimum) {
        context.addIssue({
          code: "custom",
          path: check.path,
          message: check.message,
        });
      }
    });
  });

export type SitePalette = z.infer<typeof paletteSchema>;
export type SiteSectionTints = z.infer<typeof sectionTintsSchema>;
export type SiteAppearance = z.infer<typeof siteAppearanceSchema>;

/**
 * How `appearance` becomes CSS custom properties (ESZ-021).
 *
 * This list is the shared boundary between the static export and the PHP
 * injector. Both emit exactly these names, in this order, from these sources, so
 * the `<style id="__ESZTER_APPEARANCE__">` block PHP writes at request time is
 * byte-identical in shape to the one `next build` baked in — only the values
 * differ. It is generated into `contracts/generated/http-contract.json`, so PHP
 * reads it rather than agreeing with the frontend out of band.
 *
 * Only two kinds of source are allowed, and that is the point:
 *
 *  - `palette` / `sectionTint` copy a value that already passed `hexColorSchema`;
 *  - `readableForeground` applies the contract's own contrast rule, the same one
 *    `siteAppearanceSchema` uses to police legibility.
 *
 * Neither is presentation logic, and there is deliberately no third kind. The
 * blending that produces each section's background used to happen here, in
 * TypeScript, which would have forced PHP to reimplement a colour-mixing formula
 * to inject anything. It moved into `globals.css` as `color-mix(in srgb, …)` —
 * gamma-space sRGB interpolation, the same operation `mixHexColors` performs —
 * so the ratios stay in the stylesheet where they belong and the injector only
 * ever copies validated hex.
 */
export const siteAppearanceCustomProperties = [
  { name: "--site-background", source: "palette", key: "background" },
  { name: "--site-surface", source: "palette", key: "surface" },
  { name: "--site-text", source: "palette", key: "text" },
  { name: "--site-muted-text", source: "palette", key: "mutedText" },
  { name: "--site-primary", source: "palette", key: "primary" },
  { name: "--site-primary-contrast", source: "readableForeground", key: "primary" },
  { name: "--site-secondary", source: "palette", key: "secondary" },
  { name: "--site-warm-accent", source: "palette", key: "warmAccent" },
  { name: "--site-tint-navigation", source: "sectionTint", key: "navigation" },
  { name: "--site-tint-hero", source: "sectionTint", key: "hero" },
  { name: "--site-tint-reassurance", source: "sectionTint", key: "reassurance" },
  { name: "--site-tint-services", source: "sectionTint", key: "services" },
  { name: "--site-tint-process", source: "sectionTint", key: "process" },
  { name: "--site-tint-gallery", source: "sectionTint", key: "gallery" },
  { name: "--site-tint-about", source: "sectionTint", key: "about" },
  { name: "--site-tint-contact", source: "sectionTint", key: "contact" },
  { name: "--site-tint-footer", source: "sectionTint", key: "footer" },
] as const;

export type SiteAppearanceCustomProperty =
  (typeof siteAppearanceCustomProperties)[number];

/**
 * Resolves the declared properties against one appearance document.
 *
 * Every value is re-checked with `hexColorSchema` on the way out. The appearance
 * has already been validated by the time it gets here, so this is belt and
 * braces — but it is the last gate before an editorial value becomes CSS text,
 * and `page.appearanceIsColoursOnly` is only true if something enforces it at
 * exactly this point. A value that fails is dropped, never emitted raw.
 */
export function createAppearanceCustomProperties(
  appearance: SiteAppearance,
): Array<{ name: string; value: HexColor }> {
  const resolved: Array<{ name: string; value: HexColor }> = [];

  for (const property of siteAppearanceCustomProperties) {
    const raw =
      property.source === "sectionTint"
        ? appearance.sectionTints[property.key as keyof SiteSectionTints]
        : appearance.palette[property.key as keyof SitePalette];

    const parsed = hexColorSchema.safeParse(raw);
    if (!parsed.success) continue;

    resolved.push({
      name: property.name,
      value:
        property.source === "readableForeground"
          ? getReadableForeground(parsed.data)
          : parsed.data,
    });
  }

  return resolved;
}

/**
 * The `:root { … }` block injected into the exported HTML.
 *
 * Emitted by the export with the canonical defaults and rewritten by PHP with the
 * published values. Both call this, so there is one definition of the text.
 */
export function createAppearanceStyleSheet(appearance: SiteAppearance): string {
  const declarations = createAppearanceCustomProperties(appearance)
    .map((property) => `${property.name}:${property.value}`)
    .join(";");

  return `:root{${declarations}}`;
}
