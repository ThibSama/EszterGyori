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
      { id: "parcours", label: "La séance", href: "#parcours" },
      { id: "realisations", label: "Réalisations", href: "#realisations" },
      { id: "a-propos", label: "À propos", href: "#a-propos" },
      { id: "contact", label: "Me contacter", href: "#contact" },
    ],
  },
  hero: {
    title: {
      prefix: "Un maquillage permanent",
      emphasized: "pensé pour vous",
      suffix: ", pas pour vous transformer.",
    },
    description:
      "Près de Lille, je vous accompagne vers un résultat naturel, harmonieux et adapté à votre visage, à vos envies et à votre quotidien.",
    primaryCta: {
      id: "discover-services",
      label: "Voir les prestations",
      href: "#prestations",
    },
    secondaryCta: {
      id: "contact",
      label: "M'écrire sur Instagram",
      href: "#contact",
    },
    visual: {
      id: "hero-placeholder",
      src: null,
      alt: "Un rendu frais, précis, naturel : comme vous, avec le détail en plus.",
    },
    badgeLabel: "Sur mesure",
    instagramAriaLabel: "Voir le compte Instagram d'Eszter Gyori",
  },
  reassurance: {
    items: [
      {
        id: "natural-result",
        title: "On part de vous",
        description:
          "Je prends le temps de comprendre ce que vous aimez, ce qui vous gêne et le résultat que vous imaginez. L'idée est de sublimer vos traits, pas de les remplacer.",
      },
      {
        id: "morphological-analysis",
        title: "Un résultat à votre mesure",
        description:
          "Sourcils, regard, lèvres ou taches de rousseur : l'intensité, la douceur et le fini doivent s'accorder à votre visage, à votre carnation et à votre style.",
      },
      {
        id: "hygiene-precision",
        title: "Une atmosphère bienveillante",
        description:
          "Je veux que vous vous sentiez écoutée, à l'aise et libre de poser vos questions. Mon rôle est aussi de vous rassurer avant de décider.",
      },
      {
        id: "personal-support",
        title: "Toujours en progression",
        description:
          "Le maquillage permanent demande de rester curieuse, investie et formée. Je continue à faire évoluer ma pratique pour répondre au mieux aux besoins de mes clientes.",
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
          "Pour des sourcils plus définis, plus équilibrés ou simplement plus présents. Je vous aide à choisir une intensité qui respecte votre visage et votre manière de vous maquiller.",
        ctaLabel: "En parler avec moi →",
        visualKind: "brows",
        visual: {
          id: "service-brows-placeholder",
          src: null,
          alt: "Sourcils sur mesure",
        },
      },
      {
        id: "eyeliner",
        title: "Eye-liner",
        description:
          "Pour apporter de la présence au regard, de façon très subtile ou plus marquée selon vos envies. L'objectif est de trouver le bon équilibre pour vos yeux.",
        ctaLabel: "En parler avec moi →",
        visualKind: "eyeliner",
        visual: {
          id: "service-eyeliner-placeholder",
          src: null,
          alt: "Regard intensifié",
        },
      },
      {
        id: "lips",
        title: "Lèvres",
        description:
          "Pour des lèvres à l'apparence plus régulière, plus fraîche et doucement rehaussée. La teinte et l'intensité se choisissent avec vous, selon votre carnation et le rendu souhaité.",
        ctaLabel: "En parler avec moi →",
        visualKind: "lips",
        visual: {
          id: "service-lips-placeholder",
          src: null,
          alt: "Lèvres rehaussées",
        },
      },
      {
        id: "freckles",
        title: "Faux freckles",
        description:
          "Des taches de rousseur délicates, pensées pour un effet soleil naturel. Le rendu reste léger, harmonieux et adapté à vos traits.",
        ctaLabel: "En parler avec moi →",
        visualKind: "freckles",
        visual: {
          id: "service-freckles-placeholder",
          src: null,
          alt: "Freckles effet soleil",
        },
      },
    ],
  },
  process: {
    title: "Comment se passe l'échange",
    steps: [
      {
        id: "exchange-analysis",
        number: "01",
        title: "Vous me parlez de vous",
        description:
          "On commence par vos envies, vos habitudes et vos questions. Vous pouvez m'écrire simplement, même si votre idée n'est pas encore totalement précise.",
      },
      {
        id: "drawing-validation",
        number: "02",
        title: "On précise le rendu",
        description:
          "Je vous aide à définir une direction réaliste : plus douce, plus présente, plus structurée, toujours en accord avec votre visage.",
      },
      {
        id: "procedure",
        number: "03",
        title: "Vous validez l'intention",
        description:
          "Avant de passer à la prestation, je m'assure que vous comprenez le résultat recherché et que vous vous sentez à l'aise avec la suite.",
      },
      {
        id: "healing-touch-up",
        number: "04",
        title: "Je vous accompagne après",
        description:
          "Je vous explique les recommandations adaptées à la prestation choisie et je reste disponible si vous avez des questions.",
      },
    ],
  },
  gallery: {
    title: "Réalisations",
    items: [
      {
        id: "natural-brows",
        caption: "Sourcils restructurés",
        label: "Avant / Après",
        visualKind: "beforeAfterBrows",
        featured: true,
        visual: {
          id: "gallery-natural-brows-placeholder",
          src: null,
          alt: "Avant / après sourcils restructurés",
        },
      },
      {
        id: "healed-brows",
        caption: "Résultat naturel",
        label: "Harmonie",
        visualKind: "healedBrows",
        visual: {
          id: "gallery-healed-brows-placeholder",
          src: null,
          alt: "Résultat sourcils naturel",
        },
      },
      {
        id: "delicate-eyeliner",
        caption: "Intensité du regard",
        label: "Regard",
        visualKind: "eyeliner",
        visual: {
          id: "gallery-delicate-eyeliner-placeholder",
          src: null,
          alt: "Intensité du regard",
        },
      },
      {
        id: "powder-lips",
        caption: "Lèvres rehaussées",
        label: "Avant / Après",
        visualKind: "lips",
        visual: {
          id: "gallery-powder-lips-placeholder",
          src: null,
          alt: "Avant / après lèvres rehaussées",
        },
      },
      {
        id: "freckles",
        caption: "Faux freckles naturels",
        label: "Effet soleil",
        visualKind: "freckles",
        visual: {
          id: "gallery-freckles-placeholder",
          src: null,
          alt: "Faux freckles effet soleil",
        },
      },
    ],
    instagramCta: {
      id: "instagram-more",
      label: "Voir les avant / après sur Instagram",
      href: "https://www.instagram.com/eg_maquillagepermanent/",
    },
  },
  about: {
    title: "Sziasztok, moi c'est Eszter",
    portrait: {
      id: "eszter-portrait-placeholder",
      src: null,
      alt: "Eszter Gyori, spécialiste du maquillage permanent près de Lille",
    },
    paragraphs: [
      "Je suis originaire de Hongrie. Après des études en ressources humaines, j'ai suivi ce qui m'attirait depuis longtemps : la beauté, les visages, les détails qui donnent confiance.",
      "À Paris, où j'ai vécu 12 ans, j'ai obtenu mon diplôme de maquilleuse professionnelle et j'ai exercé ce métier pendant 10 ans. J'ai ensuite posé mes valises à Lille, puis choisi de me challenger avec le maquillage permanent.",
      "Ce que je recherche reste le même : sublimer sans transformer. Je vous reçois dans une atmosphère bienveillante, avec l'envie de vous écouter, de vous guider et de vous aider à vous sentir encore mieux dans votre peau.",
    ],
  },
  contact: {
    title: "Écrivez-moi, on en parle simplement",
    description:
      "Le plus simple est de me contacter sur Instagram. Présentez-vous, dites-moi la prestation qui vous attire, le résultat que vous aimeriez obtenir et les questions que vous avez. Je vous répondrai avec une première orientation, sans pression.",
    instagramCta: {
      id: "write-instagram",
      label: "M'écrire en message privé",
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
      { id: "contact", label: "Me contacter", href: "mailto:contact@esztergyori.com" },
    ],
  },
};

export function getDefaultSiteContent(): SiteContent {
  return defaultSiteContent;
}

siteContentSchema.parse(defaultSiteContent);
