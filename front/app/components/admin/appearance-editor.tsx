import type { SiteAppearance } from "../../types/site-content";
import {
  defaultSiteAppearance,
  getAppearanceValidationMessage,
  normalizeEditableHexColor,
} from "../../lib/site-appearance";
import { SectionCard } from "./editor-cards";
import { ColorField } from "./editor-fields";

const paletteLabels: Record<keyof SiteAppearance["palette"], string> = {
  background: "Fond général",
  surface: "Surface des cartes",
  text: "Texte principal",
  mutedText: "Texte secondaire",
  primary: "Couleur principale",
  secondary: "Couleur secondaire",
  warmAccent: "Accent chaud",
};

const sectionTintLabels: Record<keyof SiteAppearance["sectionTints"], string> = {
  navigation: "Navigation",
  hero: "Hero",
  reassurance: "Réassurance",
  services: "Prestations",
  process: "Parcours",
  gallery: "Réalisations",
  about: "À propos",
  contact: "Contact",
  footer: "Pied de page",
};

export function AppearanceEditor({
  appearance,
  onChange,
  onError,
}: {
  appearance: SiteAppearance;
  onChange: (appearance: SiteAppearance) => void;
  onError: (message: string | null) => void;
}) {
  function commitAppearance(nextAppearance: SiteAppearance) {
    const message = getAppearanceValidationMessage(nextAppearance);
    if (message) {
      onError(message);
      return;
    }
    onError(null);
    onChange(nextAppearance);
  }

  function updatePalette(
    key: keyof SiteAppearance["palette"],
    rawValue: string,
  ) {
    const value = normalizeEditableHexColor(rawValue);
    if (!value) {
      onError("La couleur doit utiliser le format #RRGGBB.");
      return;
    }
    commitAppearance({
      ...appearance,
      palette: { ...appearance.palette, [key]: value },
    });
  }

  function updateTint(
    key: keyof SiteAppearance["sectionTints"],
    rawValue: string,
  ) {
    const value = normalizeEditableHexColor(rawValue);
    if (!value) {
      onError("La couleur doit utiliser le format #RRGGBB.");
      return;
    }
    commitAppearance({
      ...appearance,
      sectionTints: { ...appearance.sectionTints, [key]: value },
    });
  }

  return (
    <SectionCard
      title="Apparence"
      description="Ces réglages restent locaux tant qu'aucune publication serveur n'existe.">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-medium text-warm-800">
              Palette globale
            </h3>
            <p className="text-sm text-warm-500">
              Ces couleurs modifient l’identité globale du site tout en conservant sa mise en page.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              commitAppearance({
                ...appearance,
                palette: defaultSiteAppearance.palette,
              })
            }
            className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-4 py-2 text-sm font-medium text-sage-700 transition hover:bg-white">
            Restaurer la palette d’origine
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(paletteLabels).map(([key, label]) => (
            <ColorField
              key={key}
              id={`appearance-palette-${key}`}
              label={label}
              value={appearance.palette[key as keyof SiteAppearance["palette"]]}
              onChange={(value) =>
                updatePalette(key as keyof SiteAppearance["palette"], value)
              }
            />
          ))}
        </div>
      </div>

      <div className="space-y-4 border-t border-warm-200 pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-medium text-warm-800">
              Teintes des sections
            </h3>
            <p className="text-sm text-warm-500">
              Les teintes de section restent volontairement légères pour préserver la lisibilité.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              commitAppearance({
                ...appearance,
                sectionTints: defaultSiteAppearance.sectionTints,
              })
            }
            className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-4 py-2 text-sm font-medium text-sage-700 transition hover:bg-white">
            Restaurer les teintes d’origine
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(sectionTintLabels).map(([key, label]) => (
            <ColorField
              key={key}
              id={`appearance-section-${key}`}
              label={label}
              value={
                appearance.sectionTints[key as keyof SiteAppearance["sectionTints"]]
              }
              onChange={(value) =>
                updateTint(key as keyof SiteAppearance["sectionTints"], value)
              }
            />
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
