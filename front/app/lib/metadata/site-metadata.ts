import type { Metadata, Viewport } from "next";

export const SITE_ORIGIN = "https://eszter-gyori.vercel.app";
export const SITE_URL = `${SITE_ORIGIN}/`;
export const SITE_NAME = "Eszter Gyori";

export const SITE_TITLE = "Eszter Gyori — Maquillage permanent à Lille";
export const SITE_TITLE_TEMPLATE = "%s | Eszter Gyori";
export const SITE_DESCRIPTION =
  "Maquillage permanent et dermopigmentation près de Lille : sourcils, eye-liner, lèvres et faux freckles pour des résultats naturels.";

export const SOCIAL_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Carte de partage Eszter Gyori, maquillage permanent naturel à Lille",
} as const;

export const PUBLIC_ROBOTS: Metadata["robots"] = {
  index: true,
  follow: true,
};

export const PRIVATE_ROBOTS: Metadata["robots"] = {
  index: false,
  follow: false,
};

export const MANIFEST_PATH = "/manifest.webmanifest";

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: SITE_TITLE,
    template: SITE_TITLE_TEMPLATE,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    type: "website",
    locale: "fr_FR",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: SOCIAL_IMAGE.url,
        alt: SOCIAL_IMAGE.alt,
      },
    ],
  },
  robots: PUBLIC_ROBOTS,
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon", type: "image/png", sizes: "180x180" }],
  },
  manifest: MANIFEST_PATH,
  category: "beauty",
};

export const siteViewport: Viewport = {
  themeColor: "#7E8D87",
  colorScheme: "light",
};
