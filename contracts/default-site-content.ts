import type { SiteContent } from "./site-content.js";
import { siteContentSchema } from "./site-content.js";

export const defaultSiteContent: SiteContent = {
  navigation: {
    brandLabel: "Eszter Gyori",
    menuOpenLabel: "Ouvrir le menu",
    menuCloseLabel: "Fermer le menu",
    links: [
      { id: "prestations", label: "Prestations", href: "#prestations" },
      { id: "parcours", label: "Parcours", href: "#parcours" },
      { id: "realisations", label: "RÃ©alisations", href: "#realisations" },
      { id: "a-propos", label: "Ã€ propos", href: "#a-propos" },
      { id: "contact", label: "Prendre contact", href: "#contact" },
    ],
  },
  hero: {
    title: {
      prefix: "Un maquillage permanent",
      emphasized: "naturel",
      suffix: ", pensÃ© pour rÃ©vÃ©ler votre visage.",
    },
    description:
      "Dermopigmentation des sourcils, eye-liner, lÃ¨vres et faux freckles. Des rÃ©sultats doux et durables, prÃ¨s de Lille.",
    primaryCta: {
      id: "discover-services",
      label: "DÃ©couvrir les prestations",
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
      alt: "Portrait beautÃ© ou rÃ©sultat sourcils naturels",
    },
    badgeLabel: "Naturel",
    instagramAriaLabel: "Voir le compte Instagram d'Eszter Gyori",
  },
  reassurance: {
    items: [
      {
        id: "natural-result",
        title: "RÃ©sultat naturel",
        description:
          "Chaque trait est pensÃ© pour sublimer votre visage sans artificialitÃ©. L'objectif est toujours un rÃ©sultat qui vous ressemble.",
      },
      {
        id: "morphological-analysis",
        title: "Analyse morphologique",
        description:
          "Avant chaque sÃ©ance, une Ã©tude complÃ¨te de votre visage permet de dÃ©finir la forme et la teinte idÃ©ales.",
      },
      {
        id: "hygiene-precision",
        title: "HygiÃ¨ne et prÃ©cision",
        description:
          "MatÃ©riel stÃ©rile Ã  usage unique, pigments certifiÃ©s, protocoles stricts. Votre sÃ©curitÃ© est une prioritÃ©.",
      },
      {
        id: "personal-support",
        title: "Accompagnement personnalisÃ©",
        description:
          "De la premiÃ¨re consultation jusqu'Ã  la retouche, chaque Ã©tape est expliquÃ©e et adaptÃ©e Ã  vos besoins.",
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
          "Restructuration complÃ¨te ou densification naturelle. Technique adaptÃ©e Ã  votre type de peau et Ã  la forme de votre visage pour un rÃ©sultat harmonieux.",
        ctaLabel: "En savoir plus â†’",
        visualKind: "brows",
        visual: {
          id: "service-brows-placeholder",
          src: null,
          alt: "Photo Ã  venir",
        },
      },
      {
        id: "eyeliner",
        title: "Eye-liner",
        description:
          "Un trait subtil au ras des cils ou un eye-liner plus marquÃ© selon vos envies. Le regard est immÃ©diatement structurÃ© et mis en valeur.",
        ctaLabel: "En savoir plus â†’",
        visualKind: "eyeliner",
        visual: {
          id: "service-eyeliner-placeholder",
          src: null,
          alt: "Photo Ã  venir",
        },
      },
      {
        id: "lips",
        title: "LÃ¨vres",
        description:
          "Contour, remplissage ou candy lips. Retrouvez une couleur uniforme et un contour dÃ©fini, adaptÃ©s Ã  votre carnation naturelle.",
        ctaLabel: "En savoir plus â†’",
        visualKind: "lips",
        visual: {
          id: "service-lips-placeholder",
          src: null,
          alt: "Photo Ã  venir",
        },
      },
      {
        id: "freckles",
        title: "Faux freckles",
        description:
          "Des taches de rousseur dÃ©licates et rÃ©alistes, placÃ©es une Ã  une pour un effet soleil naturel. Technique fine et personnalisÃ©e.",
        ctaLabel: "En savoir plus â†’",
        visualKind: "freckles",
        visual: {
          id: "service-freckles-placeholder",
          src: null,
          alt: "Photo Ã  venir",
        },
      },
    ],
  },
  process: {
    title: "Comment se dÃ©roule une sÃ©ance",
    steps: [
      {
        id: "exchange-analysis",
        number: "01",
        title: "Ã‰change et analyse",
        description:
          "On discute de vos attentes et j'analyse votre visage pour dÃ©finir ensemble la forme et la teinte les plus adaptÃ©es.",
      },
      {
        id: "drawing-validation",
        number: "02",
        title: "Dessin et validation",
        description:
          "Un dessin prÃ©alable est rÃ©alisÃ© directement sur votre peau. Rien n'est dÃ©finitif tant que vous n'avez pas validÃ©.",
      },
      {
        id: "procedure",
        number: "03",
        title: "RÃ©alisation",
        description:
          "La pigmentation est rÃ©alisÃ©e avec prÃ©cision, dans un environnement calme et confortable. SÃ©ance d'environ 2 heures.",
      },
      {
        id: "healing-touch-up",
        number: "04",
        title: "Cicatrisation et retouche",
        description:
          "Le rÃ©sultat final apparaÃ®t aprÃ¨s cicatrisation. Une retouche est prÃ©vue 4 Ã  6 semaines aprÃ¨s pour parfaire le rÃ©sultat.",
      },
    ],
  },
  gallery: {
    title: "RÃ©alisations",
    items: [
      {
        id: "natural-brows",
        caption: "Sourcils naturels",
        label: "Avant / AprÃ¨s",
        visualKind: "beforeAfterBrows",
        featured: true,
        visual: {
          id: "gallery-natural-brows-placeholder",
          src: null,
          alt: "Avant / AprÃ¨s",
        },
      },
      {
        id: "healed-brows",
        caption: "Sourcils cicatrisÃ©s",
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
        caption: "Eye-liner dÃ©licat",
        label: "RÃ©sultat",
        visualKind: "eyeliner",
        visual: {
          id: "gallery-delicate-eyeliner-placeholder",
          src: null,
          alt: "RÃ©sultat",
        },
      },
      {
        id: "powder-lips",
        caption: "LÃ¨vres poudrÃ©es",
        label: "Avant / AprÃ¨s",
        visualKind: "lips",
        visual: {
          id: "gallery-powder-lips-placeholder",
          src: null,
          alt: "Avant / AprÃ¨s",
        },
      },
      {
        id: "freckles",
        caption: "Faux freckles",
        label: "RÃ©sultat",
        visualKind: "freckles",
        visual: {
          id: "gallery-freckles-placeholder",
          src: null,
          alt: "RÃ©sultat",
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
      "SpÃ©cialiste en dermopigmentation installÃ©e prÃ¨s de Lille, je pratique le maquillage permanent avec une approche centrÃ©e sur le naturel et la prÃ©cision.",
      "Mon objectif est simple : sublimer vos traits sans les transformer. Chaque visage est unique, et chaque prestation est pensÃ©e sur mesure, dans le respect de votre morphologie et de vos envies.",
      "FormÃ©e aux techniques les plus rÃ©centes, je m'engage Ã  travailler avec des pigments certifiÃ©s et du matÃ©riel stÃ©rile Ã  usage unique, pour votre sÃ©curitÃ© et votre tranquillitÃ© d'esprit.",
    ],
  },
  contact: {
    title: "Ã‰changeons sur votre projet",
    description:
      "Vous avez des questions ou souhaitez prendre rendez-vous ? Je vous rÃ©ponds avec plaisir pour discuter de vos envies et vous accompagner dans votre dÃ©marche.",
    instagramCta: {
      id: "write-instagram",
      label: "Ã‰crire sur Instagram",
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
    copyrightSuffix: "Tous droits rÃ©servÃ©s.",
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
