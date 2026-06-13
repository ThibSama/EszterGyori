import { z } from "zod";

export const SITE_CONTENT_SCHEMA_VERSION = 1;

export const navigationLinkIds = [
  "prestations",
  "parcours",
  "realisations",
  "a-propos",
  "contact",
] as const;

export const reassuranceItemIds = [
  "natural-result",
  "morphological-analysis",
  "hygiene-precision",
  "personal-support",
] as const;

export const serviceItemIds = [
  "brows",
  "eyeliner",
  "lips",
  "freckles",
] as const;

export const processStepIds = [
  "exchange-analysis",
  "drawing-validation",
  "procedure",
  "healing-touch-up",
] as const;

export const processStepNumbers = ["01", "02", "03", "04"] as const;

export const galleryItemIds = [
  "natural-brows",
  "healed-brows",
  "delicate-eyeliner",
  "powder-lips",
  "freckles",
] as const;

export const serviceVisualKinds = [
  "brows",
  "eyeliner",
  "lips",
  "freckles",
] as const;

export const galleryVisualKinds = [
  "beforeAfterBrows",
  "healedBrows",
  "eyeliner",
  "lips",
  "freckles",
] as const;

export const mediaAssetIds = [
  "hero-placeholder",
  "service-brows-placeholder",
  "service-eyeliner-placeholder",
  "service-lips-placeholder",
  "service-freckles-placeholder",
  "gallery-natural-brows-placeholder",
  "gallery-healed-brows-placeholder",
  "gallery-delicate-eyeliner-placeholder",
  "gallery-powder-lips-placeholder",
  "gallery-freckles-placeholder",
  "eszter-portrait-placeholder",
] as const;

const serviceMediaIdsByItemId: Record<ServiceItemId, MediaAssetId> = {
  brows: "service-brows-placeholder",
  eyeliner: "service-eyeliner-placeholder",
  lips: "service-lips-placeholder",
  freckles: "service-freckles-placeholder",
};

const galleryMediaIdsByItemId: Record<GalleryItemId, MediaAssetId> = {
  "natural-brows": "gallery-natural-brows-placeholder",
  "healed-brows": "gallery-healed-brows-placeholder",
  "delicate-eyeliner": "gallery-delicate-eyeliner-placeholder",
  "powder-lips": "gallery-powder-lips-placeholder",
  freckles: "gallery-freckles-placeholder",
};

const galleryVisualKindByItemId: Record<GalleryItemId, GalleryVisualKind> = {
  "natural-brows": "beforeAfterBrows",
  "healed-brows": "healedBrows",
  "delicate-eyeliner": "eyeliner",
  "powder-lips": "lips",
  freckles: "freckles",
};

const textSchema = z.string();
const internalAnchorSchema = z
  .string()
  .regex(/^#[A-Za-z0-9_-]+$/, "Doit etre une ancre interne valide.");
const emailAddressSchema = z.email("Doit etre une adresse email valide.");
const mailtoHrefSchema = z
  .string()
  .refine((value) => {
    if (!value.startsWith("mailto:")) return false;
    return emailAddressSchema.safeParse(value.slice("mailto:".length)).success;
  }, "Doit etre un lien mailto valide.");
const httpsUrlSchema = z
  .url("Doit etre une URL valide.")
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Seules les URLs HTTPS sont acceptees.",
  });
const instagramUrlSchema = httpsUrlSchema.refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
}, "Doit etre une URL Instagram HTTPS valide.");
const publicAssetPathSchema = z
  .string()
  .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/, {
    message: "Doit etre un chemin public commencant par /.",
  });
const mediaSourceSchema = z.union([
  publicAssetPathSchema,
  z
    .url("Doit etre une URL valide.")
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "Seules les URLs http(s) sont acceptees pour les medias."),
  z.null(),
]);

function strictObject<T extends z.core.$ZodLooseShape>(shape: T) {
  return z.object(shape).strict();
}

function addFixedValueIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
) {
  context.addIssue({
    code: "custom",
    path,
    message: `${label} doit conserver la valeur technique actuelle.`,
  });
}

function addExpectedValueIssue(
  context: z.RefinementCtx,
  index: number,
  field: string,
) {
  addFixedValueIssue(context, [index, field], field);
}

export type NavigationLinkId = (typeof navigationLinkIds)[number];
export type ReassuranceItemId = (typeof reassuranceItemIds)[number];
export type ServiceItemId = (typeof serviceItemIds)[number];
export type ProcessStepId = (typeof processStepIds)[number];
export type GalleryItemId = (typeof galleryItemIds)[number];
export type MediaAssetId = (typeof mediaAssetIds)[number];
export type ServiceVisualKind = (typeof serviceVisualKinds)[number];
export type GalleryVisualKind = (typeof galleryVisualKinds)[number];

export const mediaAssetSchema = strictObject({
  id: textSchema,
  src: mediaSourceSchema,
  alt: textSchema,
});

export const anchorLinkSchema = strictObject({
  id: textSchema,
  label: textSchema,
  href: internalAnchorSchema,
});

export const instagramLinkSchema = strictObject({
  id: textSchema,
  label: textSchema,
  href: instagramUrlSchema,
});

export const mailtoLinkSchema = strictObject({
  id: textSchema,
  label: textSchema,
  href: mailtoHrefSchema,
});

export const navigationContentSchema = strictObject({
  brandLabel: textSchema,
  links: z
    .array(anchorLinkSchema)
    .length(navigationLinkIds.length, {
      message: `navigation.links doit conserver ${navigationLinkIds.length} element(s).`,
    })
    .superRefine((links, context) => {
      navigationLinkIds.forEach((id, index) => {
        if (links[index]?.id !== id) {
          addExpectedValueIssue(context, index, "id");
        }
      });
    }),
  menuOpenLabel: textSchema,
  menuCloseLabel: textSchema,
});

export const heroTitleContentSchema = strictObject({
  prefix: textSchema,
  emphasized: textSchema,
  suffix: textSchema,
});

export const heroContentSchema = strictObject({
  title: heroTitleContentSchema,
  description: textSchema,
  primaryCta: anchorLinkSchema.superRefine((link, context) => {
    if (link.id !== "discover-services") addFixedValueIssue(context, ["id"], "id");
  }),
  secondaryCta: anchorLinkSchema.superRefine((link, context) => {
    if (link.id !== "contact") addFixedValueIssue(context, ["id"], "id");
  }),
  visual: mediaAssetSchema.superRefine((media, context) => {
    if (media.id !== "hero-placeholder") {
      addFixedValueIssue(context, ["id"], "id");
    }
  }),
  badgeLabel: textSchema,
  instagramAriaLabel: textSchema,
});

export const reassuranceItemSchema = strictObject({
  id: z.enum(reassuranceItemIds),
  title: textSchema,
  description: textSchema,
});

export const reassuranceContentSchema = strictObject({
  items: z
    .array(reassuranceItemSchema)
    .length(reassuranceItemIds.length, {
      message: `reassurance.items doit conserver ${reassuranceItemIds.length} element(s).`,
    })
    .superRefine((items, context) => {
      reassuranceItemIds.forEach((id, index) => {
        if (items[index]?.id !== id) addExpectedValueIssue(context, index, "id");
      });
    }),
});

export const serviceVisualKindSchema = z.enum(serviceVisualKinds);

export const serviceItemSchema = strictObject({
  id: z.enum(serviceItemIds),
  title: textSchema,
  description: textSchema,
  ctaLabel: textSchema,
  visual: mediaAssetSchema,
  visualKind: serviceVisualKindSchema,
});

export const servicesContentSchema = strictObject({
  title: textSchema,
  items: z
    .array(serviceItemSchema)
    .length(serviceItemIds.length, {
      message: `services.items doit conserver ${serviceItemIds.length} element(s).`,
    })
    .superRefine((items, context) => {
      serviceItemIds.forEach((id, index) => {
        const item = items[index];
        if (!item) return;
        if (item.id !== id) addExpectedValueIssue(context, index, "id");
        if (item.visualKind !== id) {
          addExpectedValueIssue(context, index, "visualKind");
        }
        if (item.visual.id !== serviceMediaIdsByItemId[id]) {
          addFixedValueIssue(context, [index, "visual", "id"], "visual.id");
        }
      });
    }),
});

export const processStepSchema = strictObject({
  id: z.enum(processStepIds),
  number: z.enum(processStepNumbers),
  title: textSchema,
  description: textSchema,
});

export const processContentSchema = strictObject({
  title: textSchema,
  steps: z
    .array(processStepSchema)
    .length(processStepIds.length, {
      message: `process.steps doit conserver ${processStepIds.length} element(s).`,
    })
    .superRefine((steps, context) => {
      processStepIds.forEach((id, index) => {
        const step = steps[index];
        if (!step) return;
        if (step.id !== id) addExpectedValueIssue(context, index, "id");
        if (step.number !== processStepNumbers[index]) {
          addExpectedValueIssue(context, index, "number");
        }
      });
    }),
});

export const galleryVisualKindSchema = z.enum(galleryVisualKinds);

export const galleryItemSchema = strictObject({
  id: z.enum(galleryItemIds),
  caption: textSchema,
  label: textSchema,
  visual: mediaAssetSchema,
  visualKind: galleryVisualKindSchema,
  featured: z.boolean().optional(),
});

export const galleryContentSchema = strictObject({
  title: textSchema,
  items: z
    .array(galleryItemSchema)
    .length(galleryItemIds.length, {
      message: `gallery.items doit conserver ${galleryItemIds.length} element(s).`,
    })
    .superRefine((items, context) => {
      galleryItemIds.forEach((id, index) => {
        const item = items[index];
        if (!item) return;
        if (item.id !== id) addExpectedValueIssue(context, index, "id");
        if (item.visualKind !== galleryVisualKindByItemId[id]) {
          addExpectedValueIssue(context, index, "visualKind");
        }
        if (item.visual.id !== galleryMediaIdsByItemId[id]) {
          addFixedValueIssue(context, [index, "visual", "id"], "visual.id");
        }
        if (index === 0 && item.featured !== true) {
          addExpectedValueIssue(context, index, "featured");
        }
        if (index !== 0 && item.featured !== undefined) {
          addExpectedValueIssue(context, index, "featured");
        }
      });
    }),
  instagramCta: instagramLinkSchema.superRefine((link, context) => {
    if (link.id !== "instagram-more") addFixedValueIssue(context, ["id"], "id");
  }),
});

export const aboutContentSchema = strictObject({
  title: textSchema,
  paragraphs: z.array(textSchema).length(3, {
    message: "about.paragraphs doit conserver 3 element(s).",
  }),
  portrait: mediaAssetSchema.superRefine((media, context) => {
    if (media.id !== "eszter-portrait-placeholder") {
      addFixedValueIssue(context, ["id"], "id");
    }
  }),
});

export const contactContentSchema = strictObject({
  title: textSchema,
  description: textSchema,
  instagramCta: instagramLinkSchema.superRefine((link, context) => {
    if (link.id !== "write-instagram") addFixedValueIssue(context, ["id"], "id");
  }),
  emailCta: mailtoLinkSchema.superRefine((link, context) => {
    if (link.id !== "email") addFixedValueIssue(context, ["id"], "id");
  }),
});

export const footerContentSchema = strictObject({
  copyrightName: textSchema,
  copyrightSuffix: textSchema,
  links: z
    .array(z.union([instagramLinkSchema, mailtoLinkSchema]))
    .length(2, { message: "footer.links doit conserver 2 element(s)." })
    .superRefine((links, context) => {
      if (links[0]?.id !== "instagram") addExpectedValueIssue(context, 0, "id");
      if (links[1]?.id !== "contact") addExpectedValueIssue(context, 1, "id");
    }),
});

export const siteContentSchema = strictObject({
  navigation: navigationContentSchema,
  hero: heroContentSchema,
  reassurance: reassuranceContentSchema,
  services: servicesContentSchema,
  process: processContentSchema,
  gallery: galleryContentSchema,
  about: aboutContentSchema,
  contact: contactContentSchema,
  footer: footerContentSchema,
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type LinkContent = z.infer<typeof anchorLinkSchema>;
export type NavigationContent = z.infer<typeof navigationContentSchema>;
export type HeroTitleContent = z.infer<typeof heroTitleContentSchema>;
export type HeroContent = z.infer<typeof heroContentSchema>;
export type ReassuranceItemContent = z.infer<typeof reassuranceItemSchema>;
export type ReassuranceContent = z.infer<typeof reassuranceContentSchema>;
export type ServiceItemContent = z.infer<typeof serviceItemSchema>;
export type ServicesContent = z.infer<typeof servicesContentSchema>;
export type ProcessStepContent = z.infer<typeof processStepSchema>;
export type ProcessContent = z.infer<typeof processContentSchema>;
export type GalleryItemContent = z.infer<typeof galleryItemSchema>;
export type GalleryContent = z.infer<typeof galleryContentSchema>;
export type AboutContent = z.infer<typeof aboutContentSchema>;
export type ContactContent = z.infer<typeof contactContentSchema>;
export type FooterContent = z.infer<typeof footerContentSchema>;
export type SiteContent = z.infer<typeof siteContentSchema>;

export function validateSiteContent(candidate: unknown): candidate is SiteContent {
  return siteContentSchema.safeParse(candidate).success;
}
