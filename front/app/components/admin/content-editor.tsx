"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SitePreview } from "../site-preview";
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
  MediaAsset,
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

type TextInputType = "text" | "url" | "email";

function cloneContent(content: SiteContent): SiteContent {
  return structuredClone(content);
}

function normalizeOptionalSource(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEmailFromHref(href: string): string {
  return href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
}

function setEmailHref(email: string): string {
  return `mailto:${email.trim()}`;
}

function isPreviewableImageSource(source: string): boolean {
  const trimmed = source.trim();

  if (trimmed.startsWith("/")) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: TextInputType;
  help?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-warm-800">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-warm-300/70 bg-white/80 px-3 py-2 text-sm text-warm-800 shadow-sm outline-none transition focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
      />
      {help && <p className="text-xs leading-relaxed text-warm-500">{help}</p>}
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
  rows = 4,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-warm-800">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-xl border border-warm-300/70 bg-white/80 px-3 py-2 text-sm leading-relaxed text-warm-800 shadow-sm outline-none transition focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
      />
    </div>
  );
}

function ReadOnlyId({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-warm-100/70 px-3 py-2 text-xs text-warm-500">
      <span className="font-medium text-warm-600">{label} :</span> {value}
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/70 bg-white/55 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)] backdrop-blur-xl sm:p-6">
      <div className="mb-5 space-y-1">
        <h2 className="font-display text-2xl font-normal text-warm-800">
          {title}
        </h2>
        {description && (
          <p className="text-sm leading-relaxed text-warm-500">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function ItemCard({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-warm-200/80 bg-white/65 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-base font-medium text-warm-800">{title}</h3>
        <ReadOnlyId label="ID technique" value={id} />
      </div>
      {children}
    </div>
  );
}

function MediaEditor({
  idPrefix,
  media,
  onChange,
}: {
  idPrefix: string;
  media: MediaAsset;
  onChange: (media: MediaAsset) => void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = media.src ?? "";
  const hasSource = source.trim().length > 0;
  const canPreview =
    hasSource && isPreviewableImageSource(source) && failedSource !== source;

  return (
    <div className="space-y-3 rounded-xl border border-sage-200/80 bg-sage-50/70 p-4">
      <ReadOnlyId label="ID média" value={media.id} />
      <Field
        id={`${idPrefix}-src`}
        label="Source de l'image"
        value={source}
        onChange={(value) => {
          setFailedSource(null);
          onChange({ ...media, src: normalizeOptionalSource(value) });
        }}
        help="Saisir une URL ou un chemin public. Les vrais uploads seront ajoutés plus tard avec le backend."
      />
      <Field
        id={`${idPrefix}-alt`}
        label="Texte alternatif"
        value={media.alt}
        onChange={(value) => onChange({ ...media, alt: value })}
      />
      <div className="overflow-hidden rounded-lg border border-warm-200 bg-white/70">
        {canPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source}
            alt={media.alt}
            onError={() => setFailedSource(source)}
            className="h-36 w-full object-cover"
          />
        ) : (
          <div className="flex h-28 items-center justify-center px-4 text-center text-sm text-warm-500">
            {hasSource
              ? "Aperçu indisponible : saisir une URL http(s) valide ou un chemin public commençant par /."
              : "Aucune source renseignée. Le site public conserve son placeholder actuel."}
          </div>
        )}
      </div>
    </div>
  );
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
          onChange={(prefix) =>
            onChange({ ...content, title: { ...content.title, prefix } })
          }
        />
        <Field
          id="hero-title-emphasis"
          label="Mot en emphase"
          value={content.title.emphasized}
          onChange={(emphasized) =>
            onChange({ ...content, title: { ...content.title, emphasized } })
          }
        />
        <Field
          id="hero-title-suffix"
          label="Titre après emphase"
          value={content.title.suffix}
          onChange={(suffix) =>
            onChange({ ...content, title: { ...content.title, suffix } })
          }
        />
      </div>
      <TextArea
        id="hero-description"
        label="Description"
        value={content.description}
        onChange={(description) => onChange({ ...content, description })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="hero-primary-label"
          label="Bouton principal"
          value={content.primaryCta.label}
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
        onChange={(badgeLabel) => onChange({ ...content, badgeLabel })}
      />
      <Field
        id="hero-instagram-aria"
        label="Libellé accessibilité Instagram"
        value={content.instagramAriaLabel}
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
            onChange={(title) => updateItem(item.id, { title })}
          />
          <TextArea
            id={`reassurance-${item.id}-description`}
            label="Description"
            value={item.description}
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
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.items.map((item) => (
        <ItemCard key={item.id} title={item.title} id={item.id}>
          <Field
            id={`service-${item.id}-title`}
            label="Nom de la prestation"
            value={item.title}
            onChange={(title) => updateItem(item.id, { title })}
          />
          <TextArea
            id={`service-${item.id}-description`}
            label="Description"
            value={item.description}
            onChange={(description) => updateItem(item.id, { description })}
          />
          <Field
            id={`service-${item.id}-cta`}
            label="Libellé du lien"
            value={item.ctaLabel}
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
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.steps.map((step) => (
        <ItemCard key={step.id} title={`${step.number} - ${step.title}`} id={step.id}>
          <ReadOnlyId label="Numéro fixe" value={step.number} />
          <Field
            id={`process-${step.id}-title`}
            label="Titre"
            value={step.title}
            onChange={(title) => updateStep(step.id, { title })}
          />
          <TextArea
            id={`process-${step.id}-description`}
            label="Description"
            value={step.description}
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
        onChange={(title) => onChange({ ...content, title })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="gallery-instagram-label"
          label="Libellé du bouton Instagram"
          value={content.instagramCta.label}
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
            onChange={(caption) => updateItem(item.id, { caption })}
          />
          <Field
            id={`gallery-${item.id}-label`}
            label="Étiquette visuelle"
            value={item.label}
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
        onChange={(title) => onChange({ ...content, title })}
      />
      {content.paragraphs.map((paragraph, index) => (
        <TextArea
          key={`about-paragraph-${index + 1}`}
          id={`about-paragraph-${index + 1}`}
          label={`Paragraphe ${index + 1}`}
          value={paragraph}
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
        onChange={(title) => onChange({ ...content, title })}
      />
      <TextArea
        id="contact-description"
        label="Description"
        value={content.description}
        onChange={(description) => onChange({ ...content, description })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="contact-instagram-label"
          label="Libellé Instagram"
          value={content.instagramCta.label}
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
          onChange={(label) =>
            onChange({ ...content, emailCta: { ...content.emailCta, label } })
          }
        />
        <Field
          id="contact-email-href"
          label="Adresse email"
          type="email"
          value={getEmailFromHref(content.emailCta.href)}
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
          onChange={(copyrightName) =>
            onChange({ ...content, copyrightName })
          }
        />
        <Field
          id="footer-copyright-suffix"
          label="Texte copyright"
          value={content.copyrightSuffix}
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
  const [cleanContent, setCleanContent] = useState<SiteContent>(() =>
    cloneContent(defaultContent),
  );
  const [isDirty, setIsDirty] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState(
    "Aucun brouillon local enregistré pour ce navigateur.",
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
            `Brouillon local chargé (${formatFrenchDateTime(result.draft.savedAt)}).`,
          );
        } else {
          setContent(cloneContent(defaultContent));
          setCleanContent(cloneContent(defaultContent));
          setIsDirty(false);
          setDraftSavedAt(null);
          setStatusMessage("Aucun brouillon local enregistré pour ce navigateur.");
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
    setStatusMessage("Modifications non enregistrées.");
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
      `Brouillon local enregistré (${formatFrenchDateTime(result.draft.savedAt)}).`,
    );
  }

  function handleDeleteDraft() {
    if (
      !window.confirm(
        "Supprimer le brouillon local enregistré dans ce navigateur ? Le contenu actuellement affiché restera visible jusqu'au reset ou au rafraîchissement.",
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
      "Brouillon local supprimé. Le contenu affiché reste en mémoire jusqu'au reset ou au rafraîchissement.",
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
      "Export JSON généré avec le contenu actuellement affiché, y compris les modifications non enregistrées.",
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
        "Brouillon JSON importé dans l'éditeur. Enregistrer localement pour le conserver dans ce navigateur.",
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
        "Réinitialiser toutes les modifications temporaires et revenir au contenu d'origine ?",
      )
    ) {
      const defaultClone = cloneContent(defaultContent);
      setContent(defaultClone);
      setIsDirty(!contentsEqual(defaultClone, cleanContent));
      setErrorMessage(null);
      setStatusMessage(
        "Contenu courant réinitialisé au contenu par défaut. Le brouillon local enregistré n'est pas supprimé.",
      );
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
          <div className="rounded-2xl border border-sage-300/70 bg-sage-100/75 p-4 text-sm leading-relaxed text-warm-700">
            Les modifications restent locales à ce navigateur. Un brouillon
            enregistré localement n&apos;est pas publié, n&apos;est pas envoyé à un
            serveur et n&apos;est pas disponible sur un autre appareil. Exporter un
            fichier JSON est nécessaire pour obtenir une sauvegarde portable. Il
            n&apos;y a pas encore de backend, d&apos;authentification, de publication,
            d&apos;API ou d&apos;upload d&apos;image.
          </div>
          <div className="rounded-2xl border border-warm-300/70 bg-white/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)]">
            <div className="grid gap-3 text-sm text-warm-600 md:grid-cols-3">
              <div>
                <span className="block font-medium text-warm-800">
                  État courant
                </span>
                {isDirty
                  ? "Modifications non enregistrées"
                  : "Aucune modification non enregistrée"}
              </div>
              <div>
                <span className="block font-medium text-warm-800">
                  Brouillon local
                </span>
                {draftSavedAt
                  ? `Dernier enregistrement : ${formatFrenchDateTime(draftSavedAt)}`
                  : "Aucun brouillon enregistré"}
              </div>
              <div>
                <span className="block font-medium text-warm-800">
                  Clé locale
                </span>
                <code className="break-all text-xs">
                  {SITE_CONTENT_DRAFT_STORAGE_KEY}
                </code>
              </div>
            </div>
            <p className="mt-3 text-sm text-warm-600">{statusMessage}</p>
            {errorMessage && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errorMessage}
                {hasInvalidStoredDraft && (
                  <span className="block pt-1">
                    Vous pouvez supprimer ce brouillon local invalide ci-dessous.
                  </span>
                )}
              </div>
            )}
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
              Enregistrer le brouillon local
            </button>
            <button
              type="button"
              onClick={handleExportDraft}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Exporter le brouillon JSON
            </button>
            <label
              htmlFor="admin-draft-import"
              className="inline-flex cursor-pointer items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Importer un JSON
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
              Réinitialiser les modifications
            </button>
            <button
              type="button"
              onClick={handleDeleteDraft}
              className="inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100">
              Supprimer le brouillon local
            </button>
          </div>
        </header>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] xl:items-start">
          <div className="space-y-6">
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

          <aside id="preview" className="min-w-0 space-y-4 xl:sticky xl:top-6">
            <div className="rounded-2xl border border-warm-300/70 bg-white/80 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.08)]">
              <h2 className="font-display text-2xl font-normal text-warm-800">
                Aperçu en direct
              </h2>
              <p className="text-sm text-warm-500">
                Cet aperçu utilise les mêmes composants que le site public et le
                contenu temporaire édité ci-contre.
              </p>
            </div>
            <div className="max-h-[calc(100vh-7rem)] overflow-auto rounded-2xl border border-warm-300/70 bg-warm-50 shadow-[0_12px_40px_rgba(44,43,40,0.10)] [transform:translateZ(0)]">
              <SitePreview content={content} />
            </div>
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
