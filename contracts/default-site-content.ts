import { defaultSiteAppearance } from "./appearance.js";
import type { SiteContent } from "./site-content.js";
import { siteContentSchema } from "./site-content.js";

export const defaultSiteContent: SiteContent = {
  appearance: defaultSiteAppearance,
  navigation: {
    brandLabel: "Eszter Gyori",
    menuOpenLabel: "Ouvrir le menu",
    menuCloseLabel: "Fermer le menu",
    links: [
      { id: "prestations", label: "Prestations", href: "#prestations" },
      { id: "parcours", label: "Parcours", href: "#parcours" },
      { id: "realisations", label: "Réalisations", href: "#realisations" },
      { id: "a-propos", label: "À propos", href: "#a-propos" },
      { id: "contact", label: "Prendre contact", href: "#contact" },
    ],
  },
  hero: {
    title: {
      prefix: "Un maquillage permanent",
      emphasized: "naturel",
      suffix: ", pensé pour révéler votre visage.",
    },
    description:
      "Dermopigmentation des sourcils, eye-liner, lèvres et faux freckles. Des résultats doux et durables, près de Lille.",
    primaryCta: {
      id: "discover-services",
      label: "Découvrir les prestations",
      href: "#prestations",
    },
    secondaryCta: {
      id: "contact",
      label: "Prendre contact",
      href: "#contact",
    },
    visual: {
      id: "hero-placeholder",
      src: null,
      alt: "Portrait beauté ou résultat sourcils naturels",
    },
    badgeLabel: "Naturel",
    instagramAriaLabel: "Voir le compte Instagram d'Eszter Gyori",
  },
  reassurance: {
    items: [
      {
        id: "natural-result",
        title: "Résultat naturel",
        description:
          "Chaque trait est pensé pour sublimer votre visage sans artificialité. L'objectif est toujours un résultat qui vous ressemble.",
      },
      {
        id: "morphological-analysis",
        title: "Analyse morphologique",
        description:
          "Avant chaque séance, une étude complète de votre visage permet de définir la forme et la teinte idéales.",
      },
      {
        id: "hygiene-precision",
        title: "Hygiène et précision",
        description:
          "Matériel stérile à usage unique, pigments certifiés, protocoles stricts. Votre sécurité est une priorité.",
      },
      {
        id: "personal-support",
        title: "Accompagnement personnalisé",
        description:
          "De la première consultation jusqu'à la retouche, chaque étape est expliquée et adaptée à vos besoins.",
      },
    ],
  },
  services: {
    title: "Prestations",
    items: [
      {
        id: "brows",
        title: "Sourcils",
        description:
          "Restructuration complète ou densification naturelle. Technique adaptée à votre type de peau et à la forme de votre visage pour un résultat harmonieux.",
        ctaLabel: "En savoir plus →",
        visualKind: "brows",
        visual: {
          id: "service-brows-placeholder",
          src: null,
          alt: "Photo à venir",
        },
      },
      {
        id: "eyeliner",
        title: "Eye-liner",
        description:
          "Un trait subtil au ras des cils ou un eye-liner plus marqué selon vos envies. Le regard est immédiatement structuré et mis en valeur.",
        ctaLabel: "En savoir plus →",
        visualKind: "eyeliner",
        visual: {
          id: "service-eyeliner-placeholder",
          src: null,
          alt: "Photo à venir",
        },
      },
      {
        id: "lips",
        title: "Lèvres",
        description:
          "Contour, remplissage ou candy lips. Retrouvez une couleur uniforme et un contour défini, adaptés à votre carnation naturelle.",
        ctaLabel: "En savoir plus →",
        visualKind: "lips",
        visual: {
          id: "service-lips-placeholder",
          src: null,
          alt: "Photo à venir",
        },
      },
      {
        id: "freckles",
        title: "Faux freckles",
        description:
          "Des taches de rousseur délicates et réalistes, placées une à une pour un effet soleil naturel. Technique fine et personnalisée.",
        ctaLabel: "En savoir plus →",
        visualKind: "freckles",
        visual: {
          id: "service-freckles-placeholder",
          src: null,
          alt: "Photo à venir",
        },
      },
    ],
  },
  process: {
    title: "Comment se déroule une séance",
    steps: [
      {
        id: "exchange-analysis",
        number: "01",
        title: "Échange et analyse",
        description:
          "On discute de vos attentes et j'analyse votre visage pour définir ensemble la forme et la teinte les plus adaptées.",
      },
      {
        id: "drawing-validation",
        number: "02",
        title: "Dessin et validation",
        description:
          "Un dessin préalable est réalisé directement sur votre peau. Rien n'est définitif tant que vous n'avez pas validé.",
      },
      {
        id: "procedure",
        number: "03",
        title: "Réalisation",
        description:
          "La pigmentation est réalisée avec précision, dans un environnement calme et confortable. Séance d'environ 2 heures.",
      },
      {
        id: "healing-touch-up",
        number: "04",
        title: "Cicatrisation et retouche",
        description:
          "Le résultat final apparaît après cicatrisation. Une retouche est prévue 4 à 6 semaines après pour parfaire le résultat.",
      },
    ],
  },
  gallery: {
    title: "Réalisations",
    items: [
      {
        id: "natural-brows",
        caption: "Sourcils naturels",
        label: "Avant / Après",
        visualKind: "beforeAfterBrows",
        featured: true,
        visual: {
          id: "gallery-natural-brows-placeholder",
          src: null,
          alt: "Avant / Après",
        },
      },
      {
        id: "healed-brows",
        caption: "Sourcils cicatrisés",
        label: "Cicatrisation",
        visualKind: "healedBrows",
        visual: {
          id: "gallery-healed-brows-placeholder",
          src: null,
          alt: "Cicatrisation",
        },
      },
      {
        id: "delicate-eyeliner",
        caption: "Eye-liner délicat",
        label: "Résultat",
        visualKind: "eyeliner",
        visual: {
          id: "gallery-delicate-eyeliner-placeholder",
          src: null,
          alt: "Résultat",
        },
      },
      {
        id: "powder-lips",
        caption: "Lèvres poudrées",
        label: "Avant / Après",
        visualKind: "lips",
        visual: {
          id: "gallery-powder-lips-placeholder",
          src: null,
          alt: "Avant / Après",
        },
      },
      {
        id: "freckles",
        caption: "Faux freckles",
        label: "Résultat",
        visualKind: "freckles",
        visual: {
          id: "gallery-freckles-placeholder",
          src: null,
          alt: "Résultat",
        },
      },
    ],
    instagramCta: {
      id: "instagram-more",
      label: "Voir plus sur Instagram",
      href: "https://www.instagram.com/eg_maquillagepermanent/",
    },
  },
  about: {
    title: "Eszter Gyori",
    portrait: {
      id: "eszter-portrait-placeholder",
      src: null,
      alt: "Portrait professionnel d'Eszter",
    },
    paragraphs: [
      "Spécialiste en dermopigmentation installée près de Lille, je pratique le maquillage permanent avec une approche centrée sur le naturel et la précision.",
      "Mon objectif est simple : sublimer vos traits sans les transformer. Chaque visage est unique, et chaque prestation est pensée sur mesure, dans le respect de votre morphologie et de vos envies.",
      "Formée aux techniques les plus récentes, je m'engage à travailler avec des pigments certifiés et du matériel stérile à usage unique, pour votre sécurité et votre tranquillité d'esprit.",
    ],
  },
  contact: {
    title: "Échangeons sur votre projet",
    description:
      "Vous avez des questions ou souhaitez prendre rendez-vous ? Je vous réponds avec plaisir pour discuter de vos envies et vous accompagner dans votre démarche.",
    instagramCta: {
      id: "write-instagram",
      label: "Écrire sur Instagram",
      href: "https://www.instagram.com/eg_maquillagepermanent/",
    },
    emailCta: {
      id: "email",
      label: "Envoyer un email",
      href: "mailto:contact@esztergyori.com",
    },
  },
  footer: {
    copyrightName: "Eszter Gyori",
    copyrightSuffix: "Tous droits réservés.",
    links: [
      {
        id: "instagram",
        label: "Instagram",
        href: "https://www.instagram.com/eg_maquillagepermanent/",
      },
      { id: "contact", label: "Contact", href: "mailto:contact@esztergyori.com" },
    ],
  },
};

export function getDefaultSiteContent(): SiteContent {
  return defaultSiteContent;
}

siteContentSchema.parse(defaultSiteContent);
