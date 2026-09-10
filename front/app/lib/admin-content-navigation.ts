/**
 * The editable structure of the site, as the CMS presents it (ESZ-156).
 *
 * The editor used to render every section at once and let the scroll position
 * decide what "current" meant. It now asks two questions instead — *where* in the
 * site, then *which* part of it — and renders exactly the one editor that answers
 * them. This module is the model behind those two questions, and it is data
 * rather than markup for the same reason the shell's information architecture is
 * (`admin-navigation.ts`): the facts below are then testable without rendering
 * anything.
 *
 * Three properties matter, and each is asserted rather than assumed:
 *
 * - the sections are the ones the content document actually has. The keys are
 *   `AdminPreviewSectionKey`, the identifiers the preview pipeline already
 *   speaks, so a section cannot exist here without a place in the document, an
 *   editor and a preview target. Nothing here invents a page, a block or a
 *   section the schema does not carry — the CMS stays a structured editor of one
 *   known document, not a page builder;
 * - the areas *partition* those sections: every section belongs to exactly one
 *   area, so a selection can always be resolved and the section list of an area
 *   is never empty;
 * - every resolution ends on a valid pair. {@link resolveContentSelection} takes
 *   anything — a stale hash, a mismatched pair, `null` — and returns a pair that
 *   renders, which is what stops the central panel ever going blank.
 *
 * Changing the selection is navigation, not a mutation: nothing in this file
 * touches, reads or reshapes the content document.
 */

import {
  ADMIN_PREVIEW_SECTION_BY_KEY,
  ADMIN_PREVIEW_SECTION_KEYS,
  isAdminPreviewSectionKey,
  type AdminPreviewSectionDefinition,
  type AdminPreviewSectionKey,
} from "./admin-preview-sections";

/** A section of the content document, as selected in the CMS. */
export type AdminContentSectionKey = AdminPreviewSectionKey;

export type AdminContentAreaKey = "home" | "common";

export interface AdminContentArea {
  readonly key: AdminContentAreaKey;
  readonly label: string;
  /** One line under the area label, in Esther's terms rather than the schema's. */
  readonly description: string;
  readonly sections: readonly AdminContentSectionKey[];
}

/** A resolved place in the CMS: an area and one of its sections. */
export interface AdminContentSelection {
  readonly area: AdminContentAreaKey;
  readonly section: AdminContentSectionKey;
}

/**
 * What each section is, said to the person editing it.
 *
 * The labels come from the preview model, which already names these sections for
 * the operator; only the sentence under the label is added here, because the
 * focused editor has room for it where a row of tabs did not.
 */
const SECTION_DESCRIPTIONS: Record<AdminContentSectionKey, string> = {
  appearance: "Les couleurs du site et la teinte de fond de chaque section.",
  navigation: "Le nom affiché en haut du site et les liens du menu.",
  hero: "Le premier écran : titre, accroche, boutons et image d’ouverture.",
  reassurance: "Les points rassurants affichés juste sous le premier écran.",
  services: "Les prestations présentées sur la page d’accueil, avec leurs visuels.",
  process: "Les étapes du déroulé d’un rendez-vous.",
  gallery: "Les réalisations mises en avant et leurs images.",
  about: "La présentation d’Eszter et son portrait.",
  contact: "Le bloc de contact : téléphone, e-mail, adresse et horaires.",
  footer: "Le bas de page : mentions, liens et coordonnées répétées.",
};

/**
 * The two editable areas of the site, in canonical order.
 *
 * They are the grouping the content document actually has, not a two-level
 * pattern imposed on it. The site is one public landing page, and its sections —
 * hero through contact — are the first area, in the order a visitor meets them.
 * The rest of the document is not part of that page's flow: the menu and the
 * footer frame every screen, and the appearance is the palette the whole site is
 * painted with. Filing those three under the landing page would misdescribe them;
 * inventing an extra page to hold each one would misdescribe the site.
 */
export const ADMIN_CONTENT_AREAS: readonly AdminContentArea[] = [
  {
    key: "home",
    label: "Page d’accueil",
    description: "Les sections de la page publique, dans l’ordre de lecture.",
    sections: [
      "hero",
      "reassurance",
      "services",
      "process",
      "gallery",
      "about",
      "contact",
    ],
  },
  {
    key: "common",
    label: "Éléments communs",
    description: "Ce qui encadre et habille toutes les pages du site.",
    sections: ["navigation", "footer", "appearance"],
  },
];

/**
 * Where the CMS opens, and where every unresolvable selection lands.
 *
 * The hero is the first section of the first area and the one an operator
 * recognises as "the site", which makes it the honest default; it is also the
 * only default that cannot be wrong, being the first entry of the canonical
 * order rather than a preference.
 */
export const DEFAULT_ADMIN_CONTENT_SELECTION: AdminContentSelection = {
  area: "home",
  section: "hero",
};

const AREA_BY_KEY = new Map(ADMIN_CONTENT_AREAS.map((area) => [area.key, area]));

const AREA_KEY_BY_SECTION = new Map<AdminContentSectionKey, AdminContentAreaKey>(
  ADMIN_CONTENT_AREAS.flatMap((area) =>
    area.sections.map(
      (section) => [section, area.key] as [AdminContentSectionKey, AdminContentAreaKey],
    ),
  ),
);

export function isAdminContentAreaKey(value: unknown): value is AdminContentAreaKey {
  return typeof value === "string" && AREA_BY_KEY.has(value as AdminContentAreaKey);
}

/** The area with this key. Throws rather than returning a broken screen. */
export function adminContentArea(key: AdminContentAreaKey): AdminContentArea {
  const area = AREA_BY_KEY.get(key);
  if (area === undefined) {
    throw new Error(`Unknown admin content area: ${key}`);
  }
  return area;
}

/** The area that owns this section. Total, because the areas partition them. */
export function areaKeyForContentSection(
  section: AdminContentSectionKey,
): AdminContentAreaKey {
  const areaKey = AREA_KEY_BY_SECTION.get(section);
  if (areaKey === undefined) {
    throw new Error(`Section outside every admin content area: ${section}`);
  }
  return areaKey;
}

/** The preview/editor definition of a section: label, editor and preview targets. */
export function adminContentSection(
  section: AdminContentSectionKey,
): AdminPreviewSectionDefinition {
  const definition = ADMIN_PREVIEW_SECTION_BY_KEY.get(section);
  if (definition === undefined) {
    throw new Error(`Unknown admin content section: ${section}`);
  }
  return definition;
}

/** The sentence shown under the section title in the focused workspace. */
export function adminContentSectionDescription(
  section: AdminContentSectionKey,
): string {
  return SECTION_DESCRIPTIONS[section];
}

/**
 * A valid selection, from anything.
 *
 * The section wins over the area when the two disagree: a section names exactly
 * one editor, so it is the more specific of the two, and its own area is the only
 * one that can hold it. An unknown or absent section falls back to the first
 * section of a known area, and an unknown area to the default — never to nothing,
 * because "nothing" is the blank central panel this resolution exists to prevent.
 */
export function resolveContentSelection(candidate: {
  area?: unknown;
  section?: unknown;
}): AdminContentSelection {
  if (isAdminPreviewSectionKey(candidate.section)) {
    return {
      area: areaKeyForContentSection(candidate.section),
      section: candidate.section,
    };
  }

  if (isAdminContentAreaKey(candidate.area)) {
    const section = adminContentArea(candidate.area).sections[0];
    if (section !== undefined) {
      return { area: candidate.area, section };
    }
  }

  return DEFAULT_ADMIN_CONTENT_SELECTION;
}

/**
 * The selection after the operator picks an area.
 *
 * Staying on the current section when it belongs to the chosen area matters more
 * than it looks: re-selecting the area you are already in must not throw you back
 * to its first section, or the area buttons become a way to lose your place.
 */
export function selectContentArea(
  current: AdminContentSelection,
  area: AdminContentAreaKey,
): AdminContentSelection {
  if (areaKeyForContentSection(current.section) === area) return current;
  return resolveContentSelection({ area });
}

/**
 * The location hash for a selection.
 *
 * It is the section's `editorTarget` — the anchor the editor already wrote to the
 * address bar when a section was clicked — so a link someone kept still opens the
 * section it names, and a reload comes back to the section it left.
 */
export function contentSelectionHash(selection: AdminContentSelection): string {
  return `#${adminContentSection(selection.section).editorTarget}`;
}

const SECTION_KEY_BY_EDITOR_TARGET = new Map(
  ADMIN_PREVIEW_SECTION_KEYS.map((key) => [
    adminContentSection(key).editorTarget,
    key,
  ]),
);

/**
 * The selection a location hash names, or the default.
 *
 * Deliberately total: a hash is user-supplied text, and the CMS opening on the
 * hero because a hash was stale is a better outcome than any error state.
 */
export function parseContentSelectionHash(hash: string): AdminContentSelection {
  const target = hash.startsWith("#") ? hash.slice(1) : hash;
  return resolveContentSelection({
    section: SECTION_KEY_BY_EDITOR_TARGET.get(target),
  });
}
