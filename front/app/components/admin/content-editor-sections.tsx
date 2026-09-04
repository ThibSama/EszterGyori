/**
 * The per-section content editors of the admin editor (ESZ-107).
 *
 * Pure presentation: each editor receives one section of the working document
 * and an `onChange` that already goes through the editor controller (dirty
 * tracking, edit-version bumping, status copy). No editor here owns state,
 * talks to a server or touches the device — the section they render is exactly
 * the slice the controller passed them, and the only way out is `onChange`.
 *
 * The mailto helpers are here because every editor that edits a contact email
 * must agree on the one shape: stored as `mailto:…` hrefs, edited as bare
 * addresses.
 */

import { MediaEditor } from "./media-editor";
import { ItemCard, SectionCard } from "./editor-cards";
import { Field, ReadOnlyId, TextArea } from "./editor-fields";
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
} from "../../types/site-content";

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

export function NavigationEditor({
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

export function HeroEditor({
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

export function ReassuranceEditor({
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

export function ServicesEditor({
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

export function ProcessEditor({
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

export function GalleryEditor({
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

export function AboutEditor({
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

export function ContactEditor({
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

export function FooterEditor({
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
