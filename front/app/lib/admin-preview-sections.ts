export const ADMIN_PREVIEW_NAVIGATION_MESSAGE =
  "ESZTER_ADMIN_PREVIEW_NAVIGATE";

export const ADMIN_PREVIEW_SECTION_KEYS = [
  "appearance",
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

export type AdminPreviewSectionKey = (typeof ADMIN_PREVIEW_SECTION_KEYS)[number];

export type AdminPreviewScrollAlignment = "top" | "start" | "end";

export interface AdminPreviewSectionDefinition {
  key: AdminPreviewSectionKey;
  label: string;
  editorTarget: string;
  previewTarget: string;
  previewAlignment: AdminPreviewScrollAlignment;
  fallback: string;
}

export const ADMIN_PREVIEW_SECTIONS: AdminPreviewSectionDefinition[] = [
  {
    key: "appearance",
    label: "Apparence",
    editorTarget: "editor-appearance",
    previewTarget: "site-section-hero",
    previewAlignment: "top",
    fallback: "Haut de page",
  },
  {
    key: "navigation",
    label: "Navigation",
    editorTarget: "editor-navigation",
    previewTarget: "site-section-hero",
    previewAlignment: "top",
    fallback: "Haut de page",
  },
  {
    key: "hero",
    label: "Hero",
    editorTarget: "editor-hero",
    previewTarget: "site-section-hero",
    previewAlignment: "top",
    fallback: "Haut de page",
  },
  {
    key: "reassurance",
    label: "Réassurance",
    editorTarget: "editor-reassurance",
    previewTarget: "site-section-reassurance",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "services",
    label: "Prestations",
    editorTarget: "editor-services",
    previewTarget: "site-section-services",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "process",
    label: "Parcours",
    editorTarget: "editor-process",
    previewTarget: "site-section-process",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "gallery",
    label: "Réalisations",
    editorTarget: "editor-gallery",
    previewTarget: "site-section-gallery",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "about",
    label: "À propos",
    editorTarget: "editor-about",
    previewTarget: "site-section-about",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "contact",
    label: "Contact",
    editorTarget: "editor-contact",
    previewTarget: "site-section-contact",
    previewAlignment: "start",
    fallback: "Position courante",
  },
  {
    key: "footer",
    label: "Pied de page",
    editorTarget: "editor-footer",
    previewTarget: "site-section-footer",
    previewAlignment: "end",
    fallback: "Position courante",
  },
];

export const ADMIN_PREVIEW_SECTION_BY_KEY = new Map(
  ADMIN_PREVIEW_SECTIONS.map((section) => [section.key, section]),
);

export function isAdminPreviewSectionKey(
  value: unknown,
): value is AdminPreviewSectionKey {
  return (
    typeof value === "string" &&
    ADMIN_PREVIEW_SECTION_KEYS.includes(value as AdminPreviewSectionKey)
  );
}
