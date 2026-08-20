"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AdminPreviewViewport } from "./admin-preview-viewport";
import { useAdminSession } from "./admin-session-provider";
import { AppearanceEditor } from "./appearance-editor";
import { ItemCard, SectionCard } from "./editor-cards";
import { Field, ReadOnlyId, TextArea } from "./editor-fields";
import { MediaEditor } from "./media-editor";
import type { AdminApiFailure } from "../../lib/admin-api";
import type { AdminDraftOperation } from "../../lib/admin-server-draft";
import { cloneSiteContent } from "../../lib/site-content-clone";
import {
  deleteDraft,
  loadDraft,
  MAX_DRAFT_IMPORT_BYTES,
  parseDraft,
  saveDraft,
  serializeDraft,
  SITE_CONTENT_DRAFT_STORAGE_KEY,
} from "../../lib/admin-draft-storage";
import {
  ADMIN_DRAFT_FRESHNESS_LABELS,
  ADMIN_DRAFT_MESSAGES,
  adminDraftReducer,
  canWrite,
  createInitialDraftState,
  describeDraftFreshness,
} from "../../lib/admin-server-draft";
import {
  reconcileDraftConflict,
  refreshAfterWriteConflict,
} from "../../lib/admin-draft-reconciliation";
import { describeMergeConflict } from "../../lib/site-content-merge";
import {
  ADMIN_PREVIEW_SECTIONS,
  type AdminPreviewSectionKey,
} from "../../lib/admin-preview-sections";
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const EDITOR_SECTIONS = [
  { href: "#editor-appearance", label: "Apparence" },
  { href: "#editor-navigation", label: "Navigation" },
  { href: "#editor-hero", label: "Hero" },
  { href: "#editor-reassurance", label: "Réassurance" },
  { href: "#editor-services", label: "Prestations" },
  { href: "#editor-process", label: "Parcours" },
  { href: "#editor-gallery", label: "Réalisations" },
  { href: "#editor-about", label: "À propos" },
  { href: "#editor-contact", label: "Contact" },
  { href: "#editor-footer", label: "Pied de page" },
];


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

/** The server draft line: which revision this editor is based on, and when. */
function getServerDraftState(
  revision: number | null,
  updatedAt: string | null,
): string {
  if (revision === null) return "Aucun brouillon serveur chargé";
  const stamp = updatedAt ? ` — ${formatFrenchDateTime(updatedAt)}` : "";
  return `Révision ${revision}${stamp}`;
}

/** The public line: what visitors are actually being served right now. */
function getPublishedState(
  publishedRevision: number | null,
  publishedAt: string | null,
): string {
  if (publishedRevision === null) return "État de publication inconnu";
  const stamp = publishedAt ? ` — ${formatFrenchDateTime(publishedAt)}` : "";
  return `Révision publiée ${publishedRevision}${stamp}`;
}

/** The local backup line. Explicitly secondary: it is never the source of truth. */
function getLocalBackupState(backupSavedAt: string | null): string {
  return backupSavedAt
    ? `Sauvegarde locale du ${formatFrenchDateTime(backupSavedAt)}`
    : "Aucune sauvegarde locale sur cet appareil";
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
      id="editor-navigation"
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
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
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
    <SectionCard id="editor-hero" title="Hero">
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
    <SectionCard id="editor-reassurance" title="Réassurance">
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
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
    <SectionCard id="editor-services" title="Prestations">
      <Field
        id="services-title"
        label="Titre de section"
        value={content.title}
        placeholder="Ex. Prestations"
        onChange={(title) => onChange({ ...content, title })}
      />
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
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
      id="editor-process"
      title="Parcours"
      description="La numérotation reflète l'ordre fixe des étapes et n'est pas modifiable ici.">
      <Field
        id="process-title"
        label="Titre de section"
        value={content.title}
        placeholder="Ex. Comment se déroule une séance"
        onChange={(title) => onChange({ ...content, title })}
      />
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
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
    <SectionCard id="editor-gallery" title="Réalisations">
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
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
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
    <SectionCard id="editor-about" title="À propos">
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
    <SectionCard id="editor-contact" title="Contact">
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
    <SectionCard id="editor-footer" title="Pied de page">
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
      <div className="grid gap-4 2xl:grid-cols-2">
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
      </div>
    </SectionCard>
  );
}

/**
 * Copy that more than one branch below shows, or that a test pins.
 *
 * Kept together rather than inline because these sentences are the whole UX of
 * the state model: they are what tells an admin apart "saved here", "saved on the
 * server" and "visible to the public", and a reworded duplicate of one of them
 * two hundred lines down is how those three quietly become two.
 */
const EDITOR_MESSAGES = {
  unsavedBeforePublish:
    "Enregistrez le brouillon sur le serveur avant de publier : la publication publie ce qui est enregistré, pas ce qui est affiché ici.",
  publishConfirm:
    "Publier le brouillon enregistré sur le serveur ? Le site public affichera immédiatement ce contenu.",
  resetConfirm:
    "Remplacer le brouillon du serveur par le contenu actuellement publié ? Les modifications non publiées seront perdues. Le site public restera inchangé.",
  reloadConfirm:
    "Recharger le brouillon du serveur ? Le contenu affiché ici sera remplacé. Une sauvegarde locale de vos modifications est écrite avant le remplacement.",
  reconcileRetryConfirm:
    "Comparer à nouveau le contenu affiché ici avec le brouillon du serveur ? Rien ne sera écrit tant que la fusion n’est pas possible sans perte.",
  reconcileRaceLost:
    "Le brouillon du serveur a encore changé pendant la fusion. Rien n’a été écrit. Relancez la fusion : elle ne sera jamais rejouée automatiquement.",
  reconcileWithoutBase:
    "Impossible de fusionner : l’éditeur n’a pas de version de référence du serveur. Rechargez le brouillon du serveur — une sauvegarde locale de votre travail vient d’être écrite.",
  restoreBackupConfirm:
    "Remplacer le contenu affiché dans l’éditeur par la sauvegarde locale de cet appareil ? Le brouillon du serveur ne sera pas modifié tant que vous n’enregistrez pas.",
  deleteBackupConfirm:
    "Supprimer la sauvegarde locale de cet appareil ? Le brouillon du serveur et le site public resteront inchangés.",
  importConfirm:
    "Importer ce fichier remplacera le contenu actuellement affiché dans l'éditeur. Le brouillon du serveur ne sera pas modifié tant que vous n’enregistrez pas. Continuer ?",
  backupSaved:
    "Sauvegarde locale écrite sur cet appareil. Elle sert uniquement de secours : le brouillon du serveur fait foi.",
  backupRestored:
    "Sauvegarde locale chargée dans l’éditeur. Enregistrez sur le serveur pour la conserver.",
  backupDeleted:
    "Sauvegarde locale supprimée de cet appareil. Le brouillon du serveur reste inchangé.",
  backupMissing: "Aucune sauvegarde locale n’est enregistrée sur cet appareil.",
  exported:
    "Sauvegarde JSON exportée avec le contenu actuellement affiché, y compris les modifications non enregistrées.",
  imported:
    "Fichier JSON importé dans l’éditeur. Enregistrez-le sur le serveur pour le conserver.",
  importCancelled: "Import JSON annulé. Le contenu actuel est conservé.",
} as const;

export function ContentEditor({ defaultContent }: ContentEditorProps) {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const initialContent = useMemo(() => cloneContent(defaultContent), [defaultContent]);

  const [content, setContent] = useState<SiteContent>(() =>
    cloneContent(defaultContent),
  );
  const [isDirty, setIsDirty] = useState(false);
  const [draft, dispatch] = useReducer(
    adminDraftReducer,
    undefined,
    createInitialDraftState,
  );
  const [backupSavedAt, setBackupSavedAt] = useState<string | null>(null);
  const [hasInvalidStoredBackup, setHasInvalidStoredBackup] = useState(false);
  const [activeSection, setActiveSection] =
    useState<AdminPreviewSectionKey>("hero");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const explicitNavigationUntilRef = useRef(0);

  /**
   * The base snapshot: the content of the revision `draft.revision` names.
   *
   * Kept in step with the revision by construction — both move together, and
   * only when the server hands back an envelope. That pairing is what makes the
   * three-way reconciliation possible at all: without a base, "who changed this
   * field" is unanswerable and the only recoveries left are the two lossy ones,
   * take-mine and take-theirs.
   *
   * A ref rather than state because it is read inside event handlers to decide
   * whether restored or imported content actually differs from what is stored —
   * a comparison that must not cause a render, and that would otherwise mean
   * stringifying the whole document on every keystroke.
   */
  const baseContentRef = useRef<SiteContent | null>(null);

  /**
   * Counts edits so an in-flight response can tell whether it is still current.
   *
   * A save takes a round trip, and the admin can keep typing during it. Applying
   * the server's normalised copy unconditionally on return would delete every
   * keystroke made in that window — a data-loss bug that only appears on a slow
   * connection, which is exactly where it is least acceptable.
   */
  const editVersionRef = useRef(0);

  /**
   * The content as of the last commit, readable from a callback that was created
   * earlier. Updated in an effect rather than during render: a ref written while
   * rendering is one React is free to throw away.
   */
  const contentRef = useRef(content);
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    contentRef.current = content;
    isDirtyRef.current = isDirty;
  }, [content, isDirty]);

  /**
   * Writes the editor's current content to the device as a backup.
   *
   * Never automatic on load and never authoritative: this is the "explicit
   * backup / export-recovery" role `localStorage` keeps in Package 3.2, and
   * nothing reads it back without the admin asking. It is called on its own
   * button, and on the two paths that are about to replace what is on screen —
   * a 409 and a server reload — so an unsaved edit always has somewhere to
   * survive.
   */
  const writeLocalBackup = useCallback((content?: SiteContent): boolean => {
    const result = saveDraft(content ?? contentRef.current);
    if (!result.ok) {
      dispatch({ type: "local-error", errorMessage: result.error.message });
      return false;
    }
    setBackupSavedAt(result.draft.savedAt);
    setHasInvalidStoredBackup(false);
    return true;
  }, []);

  /**
   * The single place a failed privileged call is turned into UI.
   *
   * Two side effects hang off it, and both are the difference between a useful
   * error and a dead screen: a 401 flips the whole admin area to the signed-out
   * notice, because every remaining button would 401 too; a 403 re-reads the
   * session, because `CSRF_TOKEN_INVALID` means the token rotated under a session
   * that is still perfectly alive and one refresh makes the next attempt work.
   */
  const reportFailure = useCallback(
    (operation: AdminDraftOperation, failure: AdminApiFailure) => {
      dispatch({ type: "operation-failed", operation, failure });

      if (failure.kind === "unauthenticated") {
        // Signing out replaces the whole admin area, which unmounts the editor
        // and everything in it. A session can end mid-edit — an idle tab, an
        // account disabled between two calls — so anything unsaved is written to
        // the device before the screen goes away. Without this the honest
        // handling of an expiry would itself be the data-loss path.
        if (isDirtyRef.current) writeLocalBackup();
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") {
        void refreshSession();
      }
    },
    [markExpired, refreshSession, writeLocalBackup],
  );

  const loadServerDraft = useCallback(async () => {
    dispatch({ type: "bootstrap-start" });

    const result = await api.readDraft();

    if (!result.ok) {
      reportFailure("loading", result.failure);
      return;
    }

    baseContentRef.current = cloneContent(result.value.content);
    setContent(cloneContent(result.value.content));
    setIsDirty(false);
    editVersionRef.current += 1;
    dispatch({ type: "draft-loaded", envelope: result.value });
  }, [api, reportFailure]);

  // Bootstrap: the server draft is the source of truth, so it is read before the
  // editor renders any field. The published head is read separately and
  // best-effort — it only feeds the "what the public sees" line, and a public
  // endpoint being briefly unavailable must not stop an admin from editing.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await loadServerDraft();
      if (cancelled) return;

      // Whether a backup exists is *reported*, never applied. Reading it after
      // the server draft is what lets the header say "a backup from 14:32
      // exists" without that backup ever becoming the content anyone is editing.
      const backup = loadDraft();
      setBackupSavedAt(backup.ok ? (backup.draft?.savedAt ?? null) : null);
      setHasInvalidStoredBackup(backup.ok ? false : backup.canDelete);

      const published = await api.readPublished();
      if (cancelled) return;

      dispatch(
        published.ok
          ? { type: "published-loaded", envelope: published.value }
          : { type: "published-unknown" },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [api, loadServerDraft]);

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

  // Re-run once the editor fields exist. The sections are not in the document
  // while the server draft is loading, so an observer created on mount would
  // observe nothing and the section navigation would never highlight.
  useEffect(() => {
    if (draft.phase === "loading" || draft.phase === "unavailable") return;

    const observedSections = ADMIN_PREVIEW_SECTIONS.flatMap((section) => {
      const element = document.getElementById(section.editorTarget);
      return element ? [{ section, element }] : [];
    });

    if (observedSections.length === 0) return;

    const observer = new IntersectionObserver(
      () => {
        if (Date.now() < explicitNavigationUntilRef.current) return;

        const anchorY = 160;
        let nextSection = observedSections[0]?.section.key ?? null;
        let smallestPositiveDistance = Number.POSITIVE_INFINITY;

        for (const { section, element } of observedSections) {
          const rect = element.getBoundingClientRect();
          const distance = rect.top - anchorY;
          if (distance <= 0) {
            nextSection = section.key;
            continue;
          }

          if (nextSection === null && distance < smallestPositiveDistance) {
            smallestPositiveDistance = distance;
            nextSection = section.key;
          }
        }

        if (!nextSection) return;
        setActiveSection((current) =>
          current === nextSection ? current : nextSection,
        );
      },
      {
        root: null,
        rootMargin: "-128px 0px -45% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const { element } of observedSections) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
    };
  }, [draft.phase]);

  const handleSectionNavigation = useCallback(
    (section: (typeof ADMIN_PREVIEW_SECTIONS)[number]) => {
      explicitNavigationUntilRef.current = Date.now() + 2_000;
      setActiveSection(section.key);
      document.getElementById(section.editorTarget)?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      window.history.replaceState(null, "", `#${section.editorTarget}`);
    },
    [],
  );

  function applyServerContent(next: SiteContent) {
    baseContentRef.current = cloneContent(next);
    setContent(cloneContent(next));
    setIsDirty(false);
    editVersionRef.current += 1;
  }

  function updateContent(updater: (current: SiteContent) => SiteContent) {
    editVersionRef.current += 1;
    setContent((current) => updater(current));
    setIsDirty(true);
    dispatch({
      type: "local-message",
      statusMessage:
        "Modifications non enregistrées. Elles ne sont ni sur le serveur ni publiées.",
    });
    dispatch({ type: "local-error", errorMessage: null });
  }

  async function handleSaveDraft() {
    if (!canWrite(draft) || draft.revision === null) return;

    const version = editVersionRef.current;
    dispatch({ type: "operation-start", operation: "saving" });

    const result = await api.saveDraft(
      { content: contentRef.current, expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      // A 409 is not an error to report and stop on: it is the start of the
      // reconciliation, which backs the local draft up before it does anything
      // else. Every other failure is terminal for this attempt.
      if (result.failure.kind === "conflict") {
        await reconcileAfterSaveConflict(result.failure.currentRevision);
        return;
      }
      reportFailure("saving", result.failure);
      return;
    }

    dispatch({ type: "draft-saved", envelope: result.value });

    if (editVersionRef.current === version) {
      // Nothing was typed while the request was in flight, so the server's
      // normalised copy can safely replace what is on screen.
      applyServerContent(result.value.content);
      return;
    }

    // Something was typed. The save succeeded and the revision has moved, but the
    // editor still holds newer text than the server: it stays dirty, and the
    // next save carries the revision this one just produced.
    baseContentRef.current = cloneContent(result.value.content);
  }

  async function handlePublish() {
    if (!canWrite(draft) || draft.revision === null) return;

    if (isDirty) {
      dispatch({
        type: "local-error",
        errorMessage: EDITOR_MESSAGES.unsavedBeforePublish,
      });
      return;
    }

    if (!window.confirm(EDITOR_MESSAGES.publishConfirm)) return;

    dispatch({ type: "operation-start", operation: "publishing" });

    const result = await api.publish(
      { expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshAfterRefusedAction("publishing", result.failure);
        return;
      }
      reportFailure("publishing", result.failure);
      return;
    }

    dispatch({ type: "content-published", envelope: result.value });
  }

  async function handleResetToPublished() {
    if (!canWrite(draft) || draft.revision === null) return;
    if (!window.confirm(EDITOR_MESSAGES.resetConfirm)) return;

    if (isDirty) writeLocalBackup();

    dispatch({ type: "operation-start", operation: "resetting" });

    const result = await api.resetDraft(
      { expectedRevision: draft.revision },
      csrfToken,
    );

    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshAfterRefusedAction("resetting", result.failure);
        return;
      }
      reportFailure("resetting", result.failure);
      return;
    }

    applyServerContent(result.value.content);
    dispatch({ type: "draft-reset", envelope: result.value });
  }

  /** Conflict resolution, branch one: take the server's draft, keep a backup. */
  async function handleReloadServerDraft() {
    if (!window.confirm(EDITOR_MESSAGES.reloadConfirm)) return;

    writeLocalBackup();

    dispatch({ type: "operation-start", operation: "loading" });

    const result = await api.readDraft();

    if (!result.ok) {
      reportFailure("loading", result.failure);
      return;
    }

    applyServerContent(result.value.content);
    dispatch({ type: "conflict-reloaded", envelope: result.value });
  }

  /**
   * Conflict resolution, branch two: reconcile against the server's *content*.
   *
   * This replaces the rebase that used to live here, which adopted the head named
   * in the 409 header and saved over it — a force-overwrite of a revision nobody
   * had read. The 409 stays exactly as authoritative as it was; what changes is
   * that recovery now goes and looks at what it collided with.
   *
   * Nothing is written unless the merge is clean, and the retry is single: a
   * second refusal means a third editor moved the head between the fetch and the
   * save, and a loop there would terminate only when everyone else stopped
   * typing.
   */
  async function reconcileAfterSaveConflict(reportedRevision: number | null) {
    const base = baseContentRef.current;

    if (base === null) {
      // No base snapshot means no three-way merge is possible — the editor never
      // completed a load. Back the work up and stop; the reload path is the only
      // honest offer left.
      writeLocalBackup();
      reportFailure("saving", {
        kind: "conflict",
        message: EDITOR_MESSAGES.reconcileWithoutBase,
        currentRevision: reportedRevision,
      });
      return;
    }

    const version = editVersionRef.current;
    dispatch({ type: "operation-start", operation: "reconciling" });

    const outcome = await reconcileDraftConflict({
      base,
      local: contentRef.current,
      csrfToken,
      ports: api,
      backup: (content) => writeLocalBackup(content),
    });

    if (outcome.kind === "failed") {
      if (outcome.failure.kind === "conflict") {
        // The second race. Reported, never retried.
        reportFailure("saving", outcome.failure);
        dispatch({
          type: "local-error",
          errorMessage: EDITOR_MESSAGES.reconcileRaceLost,
        });
        return;
      }
      reportFailure(outcome.stage === "read" ? "loading" : "saving", outcome.failure);
      return;
    }

    if (outcome.kind === "unresolved") {
      dispatch({
        type: "conflict-unresolved",
        conflicts: outcome.conflicts,
        // From the fetched envelope, not from the 409 header — and it is still
        // only displayed, because nothing was merged and nothing was written.
        reportedServerRevision: outcome.serverEnvelope.revision,
      });
      return;
    }

    // Merged and saved, or already contained: either way the envelope carries the
    // revision *and* its content, which is the only thing the editor adopts.
    if (editVersionRef.current === version) {
      applyServerContent(outcome.content);
    } else {
      // Typing continued during the round trip. The reconciled document is the
      // new base, and the editor stays dirty so those keystrokes are still saved
      // by the next attempt rather than silently dropped.
      baseContentRef.current = cloneContent(outcome.content);
    }

    dispatch(
      outcome.kind === "merged-saved"
        ? { type: "conflict-merged", envelope: outcome.envelope }
        : { type: "conflict-already-current", envelope: outcome.envelope },
    );
  }

  /**
   * What a refused publish or reset does: re-read, then wait to be asked again.
   *
   * There is no document to merge — both operations act on what is *stored* — so
   * the only question a 409 raises is whether the admin still means the action
   * now that the stored draft is a different one. That is not a question this
   * code may answer, so it refreshes the state and stops. No forcing, no silent
   * retry.
   */
  async function refreshAfterRefusedAction(
    operation: "publishing" | "resetting",
    failure: AdminApiFailure,
  ) {
    reportFailure(operation, failure);

    // Unsaved work is about to be at risk only if the fetched draft replaces the
    // screen, but the backup is free and the ordering has to be right the first
    // time.
    if (isDirtyRef.current) writeLocalBackup();

    dispatch({ type: "operation-start", operation: "loading" });

    const refreshed = await refreshAfterWriteConflict(api);

    if (refreshed.kind === "failed") {
      reportFailure("loading", refreshed.failure);
      return;
    }

    // Replacing the on-screen document is only safe when there is nothing
    // unsaved on it. With unsaved edits the editor keeps them, keeps its stale
    // revision, and stays in the conflict phase — where reconciliation is the
    // offer, not a forced action.
    const contentAdopted = !isDirtyRef.current;
    if (contentAdopted) applyServerContent(refreshed.envelope.content);

    dispatch(
      refreshed.published
        ? { type: "published-loaded", envelope: refreshed.published }
        : { type: "published-unknown" },
    );
    dispatch({
      type: "conflict-refreshed",
      envelope: refreshed.envelope,
      operation,
      contentAdopted,
    });
  }

  function handleSaveLocalBackup() {
    if (writeLocalBackup()) {
      dispatch({
        type: "local-message",
        statusMessage: EDITOR_MESSAGES.backupSaved,
      });
    }
  }

  function handleRestoreLocalBackup() {
    const result = loadDraft();

    if (!result.ok) {
      setHasInvalidStoredBackup(result.canDelete);
      dispatch({ type: "local-error", errorMessage: result.error.message });
      return;
    }

    if (!result.draft) {
      dispatch({ type: "local-error", errorMessage: EDITOR_MESSAGES.backupMissing });
      return;
    }

    if (!window.confirm(EDITOR_MESSAGES.restoreBackupConfirm)) return;

    const restored = cloneContent(result.draft.content);
    const stored = baseContentRef.current;

    editVersionRef.current += 1;
    setContent(restored);
    // Restoring content identical to what the server already holds is not an
    // edit, and marking it dirty would put a "unsaved changes" warning on a
    // document that matches the draft byte for byte.
    setIsDirty(stored === null || !contentsEqual(restored, stored));
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({
      type: "local-message",
      statusMessage: EDITOR_MESSAGES.backupRestored,
    });
  }

  function handleDeleteLocalBackup() {
    if (!window.confirm(EDITOR_MESSAGES.deleteBackupConfirm)) return;

    const result = deleteDraft();

    if (!result.ok) {
      dispatch({ type: "local-error", errorMessage: result.error.message });
      return;
    }

    setBackupSavedAt(null);
    setHasInvalidStoredBackup(false);
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({
      type: "local-message",
      statusMessage: EDITOR_MESSAGES.backupDeleted,
    });
  }

  function handleExportDraft() {
    const json = serializeDraft(content);
    const parsed = parseDraft(json);

    if (!parsed.ok) {
      dispatch({ type: "local-error", errorMessage: parsed.error.message });
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
    dispatch({ type: "local-error", errorMessage: null });
    dispatch({ type: "local-message", statusMessage: EDITOR_MESSAGES.exported });
  }

  async function handleImportDraft(file: File | undefined) {
    try {
      if (!file) return;

      const isJsonFile =
        file.name.toLowerCase().endsWith(".json") ||
        file.type === "application/json";

      if (!isJsonFile) {
        dispatch({
          type: "local-error",
          errorMessage: "Seuls les fichiers JSON sont acceptés.",
        });
        return;
      }

      if (file.size > MAX_DRAFT_IMPORT_BYTES) {
        dispatch({
          type: "local-error",
          errorMessage: "Le fichier dépasse la limite autorisée de 1 Mo.",
        });
        return;
      }

      const text = await file.text();
      const parsed = parseDraft(text);

      if (!parsed.ok) {
        dispatch({ type: "local-error", errorMessage: parsed.error.message });
        return;
      }

      if (!window.confirm(EDITOR_MESSAGES.importConfirm)) {
        dispatch({ type: "local-error", errorMessage: null });
        dispatch({
          type: "local-message",
          statusMessage: EDITOR_MESSAGES.importCancelled,
        });
        return;
      }

      editVersionRef.current += 1;
      setContent(cloneContent(parsed.draft.content));
      setIsDirty(true);
      dispatch({ type: "local-error", errorMessage: null });
      dispatch({ type: "local-message", statusMessage: EDITOR_MESSAGES.imported });
    } catch {
      dispatch({
        type: "local-error",
        errorMessage: "Impossible de lire ce fichier JSON dans le navigateur.",
      });
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  if (draft.phase === "loading" || draft.phase === "unavailable") {
    return (
      <main className="min-h-screen bg-warm-50 px-4 py-10 text-warm-800 sm:px-6">
        <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
          <div
            role="status"
            aria-live="polite"
            className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
            <h1 className="font-display text-2xl font-light text-warm-900">
              Éditeur de contenu Eszter
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-warm-700">
              {draft.statusMessage}
            </p>
            {draft.errorMessage && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {draft.errorMessage}
              </p>
            )}
            {draft.phase === "unavailable" && (
              <button
                type="button"
                onClick={() => {
                  void loadServerDraft();
                }}
                className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
                Réessayer
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  const freshness = describeDraftFreshness(draft, isDirty);
  const writesAllowed = canWrite(draft);

  return (
    <main className="min-h-screen bg-warm-50 text-warm-800">
      <div className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">
        <header className="mb-8 space-y-4">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-sage-600">
              Back-office
            </p>
            <h1 className="font-display text-4xl font-light text-warm-800">
              Éditeur de contenu Eszter
            </h1>
          </div>
          <div className="rounded-2xl border border-sage-300/70 bg-sage-100/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.05)]">
            <h2 className="font-display text-2xl font-normal text-warm-800">
              Brouillon enregistré sur le serveur
            </h2>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-warm-700">
              <p>
                Enregistrer envoie le brouillon au serveur : il est conservé pour
                tous les appareils et le site public n&apos;est pas modifié.
              </p>
              <p>
                Publier est une action distincte : c&apos;est elle, et elle seule,
                qui met le brouillon enregistré en ligne.
              </p>
              <p>
                La sauvegarde locale et le fichier JSON restent disponibles comme
                secours. Ils ne remplacent jamais le brouillon du serveur sans une
                action explicite.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-warm-300/70 bg-white/75 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)]">
            <p
              className="mb-3 inline-flex rounded-full bg-warm-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-porcelain"
              data-testid="admin-freshness">
              {ADMIN_DRAFT_FRESHNESS_LABELS[freshness]}
            </p>
            <div className="grid gap-3 text-sm text-warm-600 md:grid-cols-4">
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Modifications
                </span>
                {getModificationState(isDirty)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Brouillon serveur
                </span>
                {getServerDraftState(draft.revision, draft.updatedAt)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Site public
                </span>
                {getPublishedState(draft.publishedRevision, draft.publishedAt)}
              </div>
              <div className="rounded-xl bg-warm-50/80 p-3">
                <span className="block font-medium text-warm-800">
                  Sauvegarde locale
                </span>
                {getLocalBackupState(backupSavedAt)}
              </div>
            </div>
            <p
              className="mt-3 text-sm text-warm-600"
              role="status"
              aria-live="polite">
              {draft.statusMessage}
            </p>
            {draft.errorMessage && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {draft.errorMessage}
                {hasInvalidStoredBackup && (
                  <span className="block pt-1">
                    Vous pouvez supprimer cette sauvegarde locale ci-dessous.
                  </span>
                )}
              </div>
            )}

            {draft.phase === "conflict" && (
              <div
                role="alert"
                data-testid="admin-revision-conflict"
                className="mt-3 space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                <p className="font-medium">
                  {draft.conflicts.length > 0
                    ? ADMIN_DRAFT_MESSAGES.conflictUnresolved
                    : ADMIN_DRAFT_MESSAGES.conflict}
                </p>
                <p>
                  Votre version : révision {draft.revision ?? "inconnue"}. Version
                  du serveur :{" "}
                  {draft.reportedServerRevision === null
                    ? "inconnue"
                    : `révision ${draft.reportedServerRevision}`}
                  . Rien n&apos;a été écrit sur le serveur.
                </p>
                {draft.conflicts.length > 0 && (
                  <div data-testid="admin-merge-conflicts">
                    <p className="font-medium">
                      Éléments modifiés des deux côtés :
                    </p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {draft.conflicts.map((conflict) => (
                        <li key={`${conflict.kind}:${conflict.path.join(".")}`}>
                          {describeMergeConflict(conflict)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2">
                      Reprenez ces éléments dans l&apos;éditeur — en vous appuyant
                      au besoin sur l&apos;export JSON ci-dessous — puis relancez
                      la fusion. Rien ne sera écrit tant qu&apos;un chevauchement
                      subsiste.
                    </p>
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm(EDITOR_MESSAGES.reconcileRetryConfirm)) {
                        return;
                      }
                      void reconcileAfterSaveConflict(draft.reportedServerRevision);
                    }}
                    disabled={draft.busy !== null}
                    className="inline-flex items-center justify-center rounded-full bg-warm-800 px-4 py-2 text-sm font-medium text-porcelain transition hover:bg-warm-700 disabled:cursor-not-allowed disabled:opacity-60">
                    Fusionner avec la version du serveur
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleReloadServerDraft();
                    }}
                    disabled={draft.busy !== null}
                    className="inline-flex items-center justify-center rounded-full border border-amber-400 bg-white/80 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
                    Recharger la version du serveur
                  </button>
                </div>
              </div>
            )}

            <details className="mt-4 rounded-xl border border-warm-200 bg-warm-50/70 p-3 text-sm text-warm-600">
              <summary className="cursor-pointer font-medium text-warm-800">
                Informations techniques
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p>
                  Le brouillon fait autorité côté serveur. La sauvegarde de secours
                  de cet appareil utilise la clé suivante :
                </p>
                <code className="block break-all rounded-lg bg-white/80 px-3 py-2 text-xs text-warm-700">
                  {SITE_CONTENT_DRAFT_STORAGE_KEY}
                </code>
                <p>
                  Aucun identifiant de session ni jeton de sécurité n&apos;est
                  conservé dans le navigateur : la session est un cookie que la
                  page ne peut pas lire.
                </p>
                <p>
                  L&apos;upload d&apos;image, la réservation et les notifications
                  ne sont pas encore implémentés.
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
              onClick={() => {
                void handleSaveDraft();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full bg-sage-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sage-700 disabled:cursor-not-allowed disabled:opacity-60">
              Enregistrer le brouillon
            </button>
            <button
              type="button"
              onClick={() => {
                void handlePublish();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full bg-warm-900 px-5 py-2.5 text-sm font-medium text-porcelain transition hover:bg-warm-700 disabled:cursor-not-allowed disabled:opacity-60">
              Publier
            </button>
            <button
              type="button"
              onClick={() => {
                void handleResetToPublished();
              }}
              disabled={!writesAllowed}
              className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/70 px-5 py-2.5 text-sm font-medium text-warm-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
              Restaurer le contenu publié
            </button>
            <button
              type="button"
              onClick={handleSaveLocalBackup}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Sauvegarder sur cet appareil
            </button>
            <button
              type="button"
              onClick={handleRestoreLocalBackup}
              className="inline-flex items-center justify-center rounded-full border border-sage-300 bg-white/80 px-5 py-2.5 text-sm font-medium text-sage-700 transition hover:bg-white">
              Restaurer la sauvegarde locale
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
              onClick={handleDeleteLocalBackup}
              className="inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100">
              Supprimer la sauvegarde locale
            </button>
            <div className="basis-full rounded-xl border border-warm-200 bg-warm-50/75 px-3 py-2 text-sm leading-relaxed text-warm-600">
              <span className="font-medium text-warm-800">
                Sauvegarde portable : fichier JSON.
              </span>{" "}
              Le fichier exporté peut être gardé comme sauvegarde, envoyé à une
              autre personne ou importé dans un autre navigateur. Il ne modifie le
              brouillon du serveur qu&apos;après un enregistrement explicite.
            </div>
          </div>
        </header>

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(480px,2fr)] xl:items-start 2xl:gap-8">
          <div className="min-w-0 space-y-6">
            <nav
              aria-label="Sections de l’éditeur"
              className="sticky top-[4.75rem] z-20 rounded-2xl border border-warm-200/80 bg-white/85 p-3 shadow-[0_8px_24px_rgba(44,43,40,0.06)] backdrop-blur">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {ADMIN_PREVIEW_SECTIONS.map((section) => (
                  <a
                    key={section.key}
                    href={`#${section.editorTarget}`}
                    aria-current={
                      activeSection === section.key ? "true" : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      handleSectionNavigation(section);
                    }}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 ${
                      activeSection === section.key
                        ? "border-warm-800 bg-warm-800 text-porcelain"
                        : "border-warm-200 bg-warm-50/80 text-warm-600 hover:border-sage-300 hover:bg-white hover:text-warm-900"
                    }`}>
                    {section.label}
                  </a>
                ))}
              </div>
            </nav>
            <AppearanceEditor
              appearance={content.appearance}
              onChange={(appearance) =>
                updateContent((current) => ({ ...current, appearance }))
              }
              onError={(errorMessage) =>
                dispatch({ type: "local-error", errorMessage })
              }
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

          <aside
            id="preview"
            className="min-w-0 xl:sticky xl:top-[5.25rem] xl:h-[calc(100vh-6.5rem)]">
            <AdminPreviewViewport
              content={content}
              activeSection={activeSection}
            />
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
