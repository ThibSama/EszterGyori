"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AdminPreviewViewport } from "./admin-preview-viewport";
import { AppearanceEditor } from "./appearance-editor";
import { ItemCard, SectionCard } from "./editor-cards";
import { Field, ReadOnlyId, TextArea } from "./editor-fields";
import { MediaEditor } from "./media-editor";
import {
  cloneSiteContent,
  createCompleteResetState,
} from "../../lib/admin-content-reset";
import {
  deleteDraft,
  loadDraft,
  MAX_DRAFT_IMPORT_BYTES,
  parseDraft,
  saveDraft,
  serializeDraft,
  SITE_CONTENT_DRAFT_STORAGE_KEY,
} from "../../lib/admin-draft-storage";
import type {
  AboutContent,
  ContactContent,
  FooterContent,
  GalleryContent,
  GalleryItemContent,
  HeroContent,
  LinkContent,
  NavigationContent,
  ProcessContent,
  ReassuranceContent,
  ReassuranceItemContent,
  ServiceItemContent,
  ServicesContent,
  SiteContent,
} from "../../types/site-content";

interface ContentEditorProps {
  defaultContent: SiteContent;
}


function cloneContent(content: SiteContent): SiteContent {
  return cloneSiteContent(content);
}


function getEmailFromHref(href: string): string {
  return href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
}

function setEmailHref(email: string): string {
  return `mailto:${email.trim()}`;
}

function updateLink(
  links: LinkContent[],
  id: string,
  patch: Partial<Pick<LinkContent, "label" | "href">>,
): LinkContent[] {
  return links.map((link) => (link.id === id ? { ...link, ...patch } : link));
}

function formatFrenchDateTime(isoDate: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(isoDate));
}

function contentsEqual(first: SiteContent, second: SiteContent): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function getDraftFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `eszter-content-draft-${year}-${month}-${day}-${hours}${minutes}.json`;
}

function getModificationState(isDirty: boolean): string {
  return isDirty ? "Modifications non enregistrées" : "Aucune modification non enregistrée";
}

function getDraftState(draftSavedAt: string | null): string {
  return draftSavedAt
    ? `Dernier enregistrement : ${formatFrenchDateTime(draftSavedAt)}`
    : "Aucun brouillon enregistré sur cet appareil";
}

function NavigationEditor({
  content,
  onChange,
}: {
  content: NavigationContent;
  onChange: (content: NavigationContent) => void;
}) {
  return (
    <SectionCard
      title="Navigation"
      description="Les ancres restent fixes ; seuls les libellés visibles sont modifiables.">
      <Field
        id="navigation-brand"
        label="Nom affiché"
        value={content.brandLabel}
        placeholder="Ex. Eszter Gyori"
        onChange={(brandLabel) => onChange({ ...content, brandLabel })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="navigation-menu-open"
          label="Libellé accessibilité ouverture"
          value={content.menuOpenLabel}
          onChange={(menuOpenLabel) => onChange({ ...content, menuOpenLabel })}
        />
        <Field
          id="navigation-menu-close"
          label="Libellé accessibilité fermeture"
          value={content.menuCloseLabel}
          onChange={(menuCloseLabel) =>
            onChange({ ...content, menuCloseLabel })
          }
        />
      </div>
      {content.links.map((link) => (
        <ItemCard key={link.id} title={`Lien ${link.label}`} id={link.id}>
          <Field
          id={`navigation-link-${link.id}-label`}
          label="Libellé"
          value={link.label}
          placeholder="Ex. Réalisations"
          onChange={(label) =>
              onChange({
                ...content,
                links: updateLink(content.links, link.id, { label }),
              })
            }
          />
          <ReadOnlyId label="Destination fixe" value={link.href} />
        </ItemCard>
      ))}
    </SectionCard>
  );
}

function HeroEditor({
  content,
  onChange,
}: {
  content: HeroContent;
  onChange: (content: HeroContent) => void;
}) {
  return (
    <SectionCard title="Hero">
      <div className="grid gap-4 md:grid-cols-3">
        <Field
          id="hero-title-prefix"
          label="Titre avant emphase"
          value={content.title.prefix}
          placeholder="Ex. Un maquillage permanent"
          onChange={(prefix) =>
            onChange({ ...content, title: { ...content.title, prefix } })
          }
        />
        <Field
          id="hero-title-emphasis"
          label="Mot en emphase"
          value={content.title.emphasized}
          placeholder="Ex. naturel"
          onChange={(emphasized) =>
            onChange({ ...content, title: { ...content.title, emphasized } })
          }
        />
        <Field
          id="hero-title-suffix"
          label="Titre après emphase"
          value={content.title.suffix}
          placeholder="Ex. pensé pour révéler…"
          onChange={(suffix) =>
            onChange({ ...content, title: { ...content.title, suffix } })
          }
        />
      </div>
      <TextArea
        id="hero-description"
        label="Description"
        value={content.description}
        placeholder="Ex. Décrivez votre approche…"
        onChange={(description) => onChange({ ...content, description })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="hero-primary-label"
          label="Bouton principal"
          value={content.primaryCta.label}
          placeholder="Ex. Découvrir les prestations"
          onChange={(label) =>
            onChange({
              ...content,
              primaryCta: { ...content.primaryCta, label },
            })
          }
        />
        <Field
          id="hero-secondary-label"
          label="Bouton secondaire"
          value={content.secondaryCta.label}
          placeholder="Ex. Prendre contact"
          onChange={(label) =>
            onChange({
              ...content,
              secondaryCta: { ...content.secondaryCta, label },
            })
          }
        />
      </div>
      <Field
        id="hero-badge"
        label="Badge visuel"
        value={content.badgeLabel}
        placeholder="Ex. Naturel"
        onChange={(badgeLabel) => onChange({ ...content, badgeLabel })}
      />
      <Field
        id="hero-instagram-aria"
        label="Libellé accessibilité Instagram"
        value={content.instagramAriaLabel}
        placeholder="Ex. Voir le compte Instagram"
        onChange={(instagramAriaLabel) =>
          onChange({ ...content, instagramAriaLabel })
        }
      />
      <MediaEditor
        idPrefix="hero-visual"
        media={content.visual}
        onChange={(visual) => onChange({ ...content, visual })}
      />
    </SectionCard>
  );
}

function ReassuranceEditor({
  content,
  onChange,
}: {
  content: ReassuranceContent;
  onChange: (content: ReassuranceContent) => void;
}) {
  function updateItem(id: string, patch: Partial<ReassuranceItemContent>) {
    onChange({
      ...content,
      items: content.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }

  return (
    <SectionCard title="Réassurance">
      {content.items.map((item) => (
        <ItemCard key={item.id} title={item.title} id={item.id}>
          <Field
            id={`reassurance-${item.id}-title`}
            label="Titre"
            value={item.title}
            placeholder="Ex. Résultat naturel"
            onChange={(title) => updateItem(item.id, { title })}
          />
          <TextArea
            id={`reassurance-${item.id}-description`}
            label="Description"
            value={item.description}
            placeholder="Ex. Décrivez le bénéfice…"
            onChange={(description) => updateItem(item.id, { description })}
          />
        </ItemCard>
      ))}
    </SectionCard>
  );
}

function ServicesEditor({
  content,
  onChange,
}: {
  content: ServicesContent;
  onChange: (content: ServicesContent) => void;
}) {
  function updateItem(id: string, patch: Partial<ServiceItemContent>) {
    onChange({
      ...content,
      items: content.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }

  return (
    <SectionCard title="Prestations">
      <Field
        id="services-title"
        label="Titre de section"
        value={content.title}
        placeholder="Ex. Prestations"
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.items.map((item) => (
        <ItemCard key={item.id} title={item.title} id={item.id}>
          <Field
            id={`service-${item.id}-title`}
            label="Nom de la prestation"
            value={item.title}
            placeholder="Ex. Lèvres"
            onChange={(title) => updateItem(item.id, { title })}
          />
          <TextArea
            id={`service-${item.id}-description`}
            label="Description"
            value={item.description}
            placeholder="Ex. Décrivez la prestation…"
            onChange={(description) => updateItem(item.id, { description })}
          />
          <Field
            id={`service-${item.id}-cta`}
            label="Libellé du lien"
            value={item.ctaLabel}
            placeholder="Ex. En savoir plus →"
            onChange={(ctaLabel) => updateItem(item.id, { ctaLabel })}
          />
          <ReadOnlyId label="Style visuel fixe" value={item.visualKind} />
          <MediaEditor
            idPrefix={`service-${item.id}-visual`}
            media={item.visual}
            onChange={(visual) => updateItem(item.id, { visual })}
          />
        </ItemCard>
      ))}
    </SectionCard>
  );
}

function ProcessEditor({
  content,
  onChange,
}: {
  content: ProcessContent;
  onChange: (content: ProcessContent) => void;
}) {
  function updateStep(
    id: string,
    patch: Partial<Pick<ProcessContent["steps"][number], "title" | "description">>,
  ) {
    onChange({
      ...content,
      steps: content.steps.map((step) =>
        step.id === id ? { ...step, ...patch } : step,
      ),
    });
  }

  return (
    <SectionCard
      title="Parcours"
      description="La numérotation reflète l'ordre fixe des étapes et n'est pas modifiable ici.">
      <Field
        id="process-title"
        label="Titre de section"
        value={content.title}
        placeholder="Ex. Comment se déroule une séance"
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.steps.map((step) => (
        <ItemCard key={step.id} title={`${step.number} - ${step.title}`} id={step.id}>
          <ReadOnlyId label="Numéro fixe" value={step.number} />
          <Field
            id={`process-${step.id}-title`}
            label="Titre"
            value={step.title}
            placeholder="Ex. Échange et analyse"
            onChange={(title) => updateStep(step.id, { title })}
          />
          <TextArea
            id={`process-${step.id}-description`}
            label="Description"
            value={step.description}
            placeholder="Ex. Décrivez l’étape…"
            onChange={(description) => updateStep(step.id, { description })}
          />
        </ItemCard>
      ))}
    </SectionCard>
  );
}

function GalleryEditor({
  content,
  onChange,
}: {
  content: GalleryContent;
  onChange: (content: GalleryContent) => void;
}) {
  function updateItem(id: string, patch: Partial<GalleryItemContent>) {
    onChange({
      ...content,
      items: content.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }

  return (
    <SectionCard title="Réalisations">
      <Field
        id="gallery-title"
        label="Titre de section"
        value={content.title}
        placeholder="Ex. Réalisations"
        onChange={(title) => onChange({ ...content, title })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="gallery-instagram-label"
          label="Libellé du bouton Instagram"
          value={content.instagramCta.label}
          placeholder="Ex. Voir plus sur Instagram"
          onChange={(label) =>
            onChange({
              ...content,
              instagramCta: { ...content.instagramCta, label },
            })
          }
        />
        <Field
          id="gallery-instagram-href"
          label="URL Instagram"
          type="url"
          value={content.instagramCta.href}
          placeholder="Ex. https://www.instagram.com/…"
          onChange={(href) =>
            onChange({
              ...content,
              instagramCta: { ...content.instagramCta, href },
            })
          }
        />
      </div>
      {content.items.map((item) => (
        <ItemCard key={item.id} title={item.caption} id={item.id}>
          <Field
            id={`gallery-${item.id}-caption`}
            label="Légende"
            value={item.caption}
            placeholder="Ex. Sourcils naturels"
            onChange={(caption) => updateItem(item.id, { caption })}
          />
          <Field
            id={`gallery-${item.id}-label`}
            label="Étiquette visuelle"
            value={item.label}
            placeholder="Ex. Résultat naturel"
            onChange={(label) => updateItem(item.id, { label })}
          />
          <ReadOnlyId label="Style visuel fixe" value={item.visualKind} />
          <MediaEditor
            idPrefix={`gallery-${item.id}-visual`}
            media={item.visual}
            onChange={(visual) => updateItem(item.id, { visual })}
          />
        </ItemCard>
      ))}
    </SectionCard>
  );
}

function AboutEditor({
  content,
  onChange,
}: {
  content: AboutContent;
  onChange: (content: AboutContent) => void;
}) {
  return (
    <SectionCard title="À propos">
      <Field
        id="about-title"
        label="Titre"
        value={content.title}
        placeholder="Ex. Eszter Gyori"
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.paragraphs.map((paragraph, index) => (
        <TextArea
          key={`about-paragraph-${index + 1}`}
          id={`about-paragraph-${index + 1}`}
          label={`Paragraphe ${index + 1}`}
          value={paragraph}
          placeholder="Ex. Présentez votre approche…"
          onChange={(value) =>
            onChange({
              ...content,
              paragraphs: content.paragraphs.map((current, currentIndex) =>
                currentIndex === index ? value : current,
              ),
            })
          }
        />
      ))}
      <MediaEditor
        idPrefix="about-portrait"
        media={content.portrait}
        onChange={(portrait) => onChange({ ...content, portrait })}
      />
    </SectionCard>
  );
}

function ContactEditor({
  content,
  onChange,
}: {
  content: ContactContent;
  onChange: (content: ContactContent) => void;
}) {
  return (
    <SectionCard title="Contact">
      <Field
        id="contact-title"
        label="Titre"
        value={content.title}
        placeholder="Ex. Échangeons sur votre projet"
        onChange={(title) => onChange({ ...content, title })}
      />
      <TextArea
        id="contact-description"
        label="Description"
        value={content.description}
        placeholder="Ex. Invitez à prendre contact…"
        onChange={(description) => onChange({ ...content, description })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="contact-instagram-label"
          label="Libellé Instagram"
          value={content.instagramCta.label}
          placeholder="Ex. Écrire sur Instagram"
          onChange={(label) =>
            onChange({
              ...content,
              instagramCta: { ...content.instagramCta, label },
            })
          }
        />
        <Field
          id="contact-instagram-href"
          label="URL Instagram"
          type="url"
          value={content.instagramCta.href}
          placeholder="Ex. https://www.instagram.com/…"
          onChange={(href) =>
            onChange({
              ...content,
              instagramCta: { ...content.instagramCta, href },
            })
          }
        />
        <Field
          id="contact-email-label"
          label="Libellé email"
          value={content.emailCta.label}
          placeholder="Ex. Envoyer un email"
          onChange={(label) =>
            onChange({ ...content, emailCta: { ...content.emailCta, label } })
          }
        />
        <Field
          id="contact-email-href"
          label="Adresse email"
          type="email"
          value={getEmailFromHref(content.emailCta.href)}
          placeholder="Ex. contact@example.com"
          onChange={(email) =>
            onChange({
              ...content,
              emailCta: { ...content.emailCta, href: setEmailHref(email) },
            })
          }
        />
      </div>
    </SectionCard>
  );
}

function FooterEditor({
  content,
  onChange,
}: {
  content: FooterContent;
  onChange: (content: FooterContent) => void;
}) {
  return (
    <SectionCard title="Pied de page">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="footer-copyright-name"
          label="Nom copyright"
          value={content.copyrightName}
          placeholder="Ex. Eszter Gyori"
          onChange={(copyrightName) =>
            onChange({ ...content, copyrightName })
          }
        />
        <Field
          id="footer-copyright-suffix"
          label="Texte copyright"
          value={content.copyrightSuffix}
          placeholder="Ex. Tous droits réservés."
          onChange={(copyrightSuffix) =>
            onChange({ ...content, copyrightSuffix })
          }
        />
      </div>
      {content.links.map((link) => (
        <ItemCard key={link.id} title={`Lien ${link.label}`} id={link.id}>
          <Field
            id={`footer-${link.id}-label`}
            label="Libellé"
            value={link.label}
            placeholder="Ex. Contact"
            onChange={(label) =>
              onChange({
                ...content,
                links: updateLink(content.links, link.id, { label }),
              })
            }
          />
          {link.href.startsWith("mailto:") ? (
            <Field
              id={`footer-${link.id}-email`}
              label="Adresse email"
              type="email"
              value={getEmailFromHref(link.href)}
              placeholder="Ex. contact@example.com"
              onChange={(email) =>
                onChange({
                  ...content,
                  links: updateLink(content.links, link.id, {
                    href: setEmailHref(email),
                  }),
                })
              }
            />
          ) : (
            <Field
              id={`footer-${link.id}-url`}
              label="URL"
              type="url"
              value={link.href}
              placeholder="Ex. https://www.instagram.com/…"
              onChange={(href) =>
                onChange({
                  ...content,
                  links: updateLink(content.links, link.id, { href }),
                })
              }
            />
          )}
        </ItemCard>
      ))}
    </SectionCard>
  );
}

export function ContentEditor({ defaultContent }: ContentEditorProps) {
  const initialContent = useMemo(() => cloneContent(defaultContent), [defaultContent]);
  const [content, setContent] = useState<SiteContent>(() =>
    cloneContent(defaultContent),
  );
  const [, setCleanContent] = useState<SiteContent>(() =>
    cloneContent(defaultContent),
  );
  const [isDirty, setIsDirty] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState(
    "Aucun brouillon enregistré sur cet appareil.",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasInvalidStoredDraft, setHasInvalidStoredDraft] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;

    queueMicrotask(() => {
      if (!mounted) return;

      const result = loadDraft();

      if (result.ok) {
        if (result.draft) {
          const restoredContent = cloneContent(result.draft.content);
          setContent(restoredContent);
          setCleanContent(cloneContent(result.draft.content));
          setIsDirty(false);
          setDraftSavedAt(result.draft.savedAt);
          setStatusMessage(
            `Brouillon chargé depuis ce navigateur (${formatFrenchDateTime(result.draft.savedAt)}). Le site public reste inchangé.`,
          );
        } else {
          setContent(cloneContent(defaultContent));
          setCleanContent(cloneContent(defaultContent));
          setIsDirty(false);
          setDraftSavedAt(null);
          setStatusMessage("Aucun brouillon enregistré sur cet appareil.");
        }
        setErrorMessage(null);
        setHasInvalidStoredDraft(false);
        return;
      }

      setContent(cloneContent(defaultContent));
      setCleanContent(cloneContent(defaultContent));
      setIsDirty(false);
      setDraftSavedAt(null);
      setErrorMessage(result.error.message);
      setHasInvalidStoredDraft(result.canDelete);
      setStatusMessage(
        "Le contenu par défaut est affiché car le brouillon local n'a pas pu être chargé.",
      );
    });

    return () => {
      mounted = false;
    };
  }, [defaultContent]);

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty]);

  function updateContent(updater: (current: SiteContent) => SiteContent) {
    setContent((current) => updater(current));
    setIsDirty(true);
    setStatusMessage("Modifications non enregistrées dans ce navigateur.");
    setErrorMessage(null);
  }

  function handleSaveDraft() {
    const result = saveDraft(content);

    if (!result.ok) {
      setErrorMessage(result.error.message);
      return;
    }

    setCleanContent(cloneContent(result.draft.content));
    setIsDirty(false);
    setDraftSavedAt(result.draft.savedAt);
    setHasInvalidStoredDraft(false);
    setErrorMessage(null);
    setStatusMessage(
      `Brouillon enregistré dans ce navigateur (${formatFrenchDateTime(result.draft.savedAt)}). Le site public reste inchangé.`,
    );
  }

  function handleDeleteDraft() {
    if (
      !window.confirm(
        "Supprimer le brouillon enregistré sur cet appareil ? Le site public restera inchangé. Le contenu actuellement affiché restera visible jusqu'à une restauration ou un rafraîchissement.",
      )
    ) {
      return;
    }

    const result = deleteDraft();

    if (!result.ok) {
      setErrorMessage(result.error.message);
      return;
    }

    const defaultClone = cloneContent(defaultContent);
    setCleanContent(defaultClone);
    setIsDirty(!contentsEqual(content, defaultClone));
    setDraftSavedAt(null);
    setHasInvalidStoredDraft(false);
    setErrorMessage(null);
    setStatusMessage(
      "Brouillon supprimé de cet appareil. Le site public reste inchangé.",
    );
  }

  function handleExportDraft() {
    const json = serializeDraft(content);
    const parsed = parseDraft(json);

    if (!parsed.ok) {
      setErrorMessage(parsed.error.message);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = getDraftFileName(new Date(parsed.draft.savedAt));
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setErrorMessage(null);
    setStatusMessage(
      "Sauvegarde JSON exportée avec le contenu actuellement affiché, y compris les modifications non enregistrées.",
    );
  }

  async function handleImportDraft(file: File | undefined) {
    try {
      if (!file) return;

      const isJsonFile =
        file.name.toLowerCase().endsWith(".json") ||
        file.type === "application/json";

      if (!isJsonFile) {
        setErrorMessage("Seuls les fichiers JSON sont acceptés.");
        return;
      }

      if (file.size > MAX_DRAFT_IMPORT_BYTES) {
        setErrorMessage("Le fichier dépasse la limite autorisée de 1 Mo.");
        return;
      }

      const text = await file.text();
      const parsed = parseDraft(text);

      if (!parsed.ok) {
        setErrorMessage(parsed.error.message);
        return;
      }

      if (
        !window.confirm(
          "Importer ce fichier remplacera le contenu actuellement affiché dans l'éditeur. Continuer ?",
        )
      ) {
        setStatusMessage("Import JSON annulé. Le contenu actuel est conservé.");
        setErrorMessage(null);
        return;
      }

      setContent(cloneContent(parsed.draft.content));
      setIsDirty(true);
      setErrorMessage(null);
      setStatusMessage(
        "Fichier JSON importé dans l'éditeur. Enregistrez-le sur cet appareil pour le conserver dans ce navigateur.",
      );
    } catch {
      setErrorMessage("Impossible de lire ce fichier JSON dans le navigateur.");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function resetContent() {
    if (
      window.confirm(
        "Cette action supprimera le brouillon enregistré sur cet appareil et restaurera l’intégralité du contenu d’origine dans l’éditeur. Le site public restera inchangé. Continuer ?",
      )
    ) {
      const result = createCompleteResetState(defaultContent, deleteDraft());

      if (!result.ok) {
        setErrorMessage(result.errorMessage);
        return;
      }

      setContent(result.state.content);
      setCleanContent(result.state.cleanContent);
      setIsDirty(result.state.isDirty);
      setDraftSavedAt(result.state.draftSavedAt);
      setHasInvalidStoredDraft(result.state.hasInvalidStoredDraft);
      setErrorMessage(result.state.errorMessage);
      setStatusMessage(result.state.statusMessage);
    }
  }

  return (
    <main className="min-h-screen bg-warm-50 text-warm-800">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8 space-y-4">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-sage-600">
              Prototype frontend
            </p>
            <h1 className="font-display text-4xl font-light text-warm-800">
              Éditeur de contenu Eszter
            </h1>
          </div>
          <div className="rounded-2xl border border-sage-300/70 bg-sage-100/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.05)]">
            <h2 className="font-display text-2xl font-normal text-warm-800">
              Brouillon enregistré uniquement sur cet appareil
            </h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-warm-700">
              <p>
                Enregistrer conserve le brouillon dans ce navigateur uniquement.
                Le site public n&apos;est pas modifié. Pour sauvegarder ou
                transférer le travail, exportez le fichier JSON.
              </p>
              <p>
                La suppression des données du navigateur ou l&apos;utilisation de
                la navigation privée peut supprimer le brouillon.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-warm-300/70 bg-white/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)]">
            <div className="grid gap-3 text-sm text-warm-600 md:grid-cols-3">
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Modifications
                </span>
                {getModificationState(isDirty)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Brouillon sur cet appareil
                </span>
                {getDraftState(draftSavedAt)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Site public
                </span>
                Inchangé
              </div>
            </div>
            <p
              className="mt-3 text-sm text-warm-600"
              role="status"
              aria-live="polite">
              {statusMessage}
            </p>
            {errorMessage && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errorMessage}
                {hasInvalidStoredDraft && (
                  <span className="block pt-1">
                    Vous pouvez supprimer ce brouillon de cet appareil ci-dessous.
                  </span>
                )}
              </div>
            )}
            <details className="mt-4 rounded-xl border border-warm-200 bg-warm-50/70 p-3 text-sm text-warm-600">
              <summary className="cursor-pointer font-medium text-warm-800">
                Informations techniques
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p>
                  Le brouillon est conservé dans le stockage du navigateur avec
                  la clé suivante :
                </p>
                <code className="block break-all rounded-lg bg-white/80 px-3 py-2 text-xs text-warm-700">
                  {SITE_CONTENT_DRAFT_STORAGE_KEY}
                </code>
                <p>
                  Il n&apos;y a pas encore de sauvegarde serveur, de publication,
                  d&apos;écriture API admin ou d&apos;upload d&apos;image dans ce prototype.
                </p>
              </div>
            </details>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-warm-300/70 bg-white/65 p-4 sm:flex-row sm:flex-wrap sm:items-center">
            <a
              href="#preview"
              className="inline-flex items-center justify-center rounded-full bg-warm-800 px-5 py-2.5 text-sm font-medium text-porcelain transition hover:bg-warm-700">
              Voir l&apos;aperçu
            </a>
            <button
              type="button"
              onClick={handleSaveDraft}
              className="inline-flex items-center justify-center rounded-full bg-sage-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sage-700">
              Enregistrer sur cet appareil
            </button>
            <button
              type="button"
              onClick={handleExportDraft}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Exporter une sauvegarde JSON
            </button>
            <label
              htmlFor="admin-draft-import"
              className="inline-flex cursor-pointer items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Importer un fichier JSON
            </label>
            <input
              ref={fileInputRef}
              id="admin-draft-import"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                void handleImportDraft(event.target.files?.[0]);
              }}
              className="sr-only"
            />
            <button
              type="button"
              onClick={resetContent}
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/70 px-5 py-2.5 text-sm font-medium text-warm-700 transition hover:bg-white">
              Restaurer le contenu d&apos;origine
            </button>
            <button
              type="button"
              onClick={handleDeleteDraft}
              className="inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100">
              Supprimer le brouillon de cet appareil
            </button>
            <div className="basis-full rounded-xl border border-warm-200 bg-warm-50/75 px-3 py-2 text-sm leading-relaxed text-warm-600">
              <span className="font-medium text-warm-800">
                Sauvegarde portable : fichier JSON.
              </span>{" "}
              Le fichier exporté peut être gardé comme sauvegarde, envoyé à une
              autre personne ou importé dans un autre navigateur.
            </div>
          </div>
        </header>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] xl:items-start">
          <div className="space-y-6">
            <AppearanceEditor
              appearance={content.appearance}
              onChange={(appearance) =>
                updateContent((current) => ({ ...current, appearance }))
              }
              onError={setErrorMessage}
            />
            <NavigationEditor
              content={content.navigation}
              onChange={(navigation) =>
                updateContent((current) => ({ ...current, navigation }))
              }
            />
            <HeroEditor
              content={content.hero}
              onChange={(hero) =>
                updateContent((current) => ({ ...current, hero }))
              }
            />
            <ReassuranceEditor
              content={content.reassurance}
              onChange={(reassurance) =>
                updateContent((current) => ({ ...current, reassurance }))
              }
            />
            <ServicesEditor
              content={content.services}
              onChange={(services) =>
                updateContent((current) => ({ ...current, services }))
              }
            />
            <ProcessEditor
              content={content.process}
              onChange={(process) =>
                updateContent((current) => ({ ...current, process }))
              }
            />
            <GalleryEditor
              content={content.gallery}
              onChange={(gallery) =>
                updateContent((current) => ({ ...current, gallery }))
              }
            />
            <AboutEditor
              content={content.about}
              onChange={(about) =>
                updateContent((current) => ({ ...current, about }))
              }
            />
            <ContactEditor
              content={content.contact}
              onChange={(contact) =>
                updateContent((current) => ({ ...current, contact }))
              }
            />
            <FooterEditor
              content={content.footer}
              onChange={(footer) =>
                updateContent((current) => ({ ...current, footer }))
              }
            />
          </div>

          <aside id="preview" className="min-w-0 xl:sticky xl:top-6">
            <AdminPreviewViewport content={content} />
          </aside>
        </div>

        <p className="mt-8 text-xs text-warm-400">
          Référence initiale chargée : {initialContent.navigation.brandLabel}.
          Les IDs techniques restent disponibles au rendu mais ne sont pas
          éditables.
        </p>
      </div>
    </main>
  );
}
