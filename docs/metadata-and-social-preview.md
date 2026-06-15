# Metadonnees et apercus sociaux

Date: 2026-06-15

## URL canonique

L'origine publique canonique est:

```text
https://eszter-gyori.vercel.app
```

La page publique canonique est:

```text
https://eszter-gyori.vercel.app/
```

Les metadonnees ne doivent pas utiliser de domaine de preview Vercel, de `localhost` ou de domaine API d'exemple.

## Strategie de titres

Titre public par defaut:

```text
Eszter Gyori — Maquillage permanent à Lille
```

Template des sous-pages:

```text
%s | Eszter Gyori
```

Les pages admin restent concises et privees:

```text
Administration | Eszter Gyori
Connexion | Eszter Gyori
Aperçu | Eszter Gyori
```

## Description canonique

Description publique:

```text
Maquillage permanent et dermopigmentation près de Lille : sourcils, eye-liner, lèvres et faux freckles pour des résultats naturels.
```

Elle evite les prix, horaires, adresse, telephone, garanties medicales ou resultats promis.

## Architecture

Les constantes partagees vivent dans:

```text
front/app/lib/metadata/site-metadata.ts
```

Le layout racine configure les metadonnees statiques App Router:

- `metadataBase`;
- titre et template;
- description;
- canonical;
- Open Graph;
- Twitter/X;
- robots publics;
- icones;
- manifest;
- categorie.

La couleur de theme est exposee par l'export `viewport`, conformement aux conventions Next.js App Router utilisees par la version installee.

## Favicon et icones

Le favicon moderne est:

```text
front/app/icon.svg
```

Concept: monogramme `E` minimal, fond chaud neutre, texte charbon, accent sauge.

L'icone Apple est generee par:

```text
front/app/apple-icon.tsx
```

Elle produit une image PNG carree de 180 x 180 px, sans dependance distante.

## Manifest

Le manifest est genere par:

```text
front/app/manifest.ts
```

Champs principaux:

- `name`: `Eszter Gyori — Maquillage permanent`;
- `short_name`: `Eszter Gyori`;
- `description`: description canonique;
- `start_url`: `/`;
- `display`: `standalone`;
- `background_color`: `#F5F4F1`;
- `theme_color`: `#7E8D87`;
- `lang`: `fr`;
- icones: `/icon.svg`, `/apple-icon`.

Aucun service worker, mode offline, notification push ou architecture PWA complete n'est ajoute.

## Open Graph

L'image Open Graph est generee par:

```text
front/app/opengraph-image.tsx
```

Format:

```text
1200 x 630
image/png
```

Direction visuelle: fond chaud neutre, formes sauge et mist discretes, surface centrale douce, texte `Eszter Gyori`, mention `Maquillage permanent naturel` et `Lille`.

Elle n'utilise ni photographie, ni faux portrait, ni produit cosmetique, ni rose, ni or.

## Twitter/X

Twitter/X utilise:

```text
summary_large_image
```

L'image Open Graph est reutilisee afin d'eviter une deuxieme implementation visuelle identique.

Aucun identifiant Twitter/X n'est configure car aucun compte verifie n'est present dans le contenu canonique.

## Robots

Le fichier:

```text
front/app/robots.ts
```

autorise la page publique et exclut l'administration:

```text
Allow: /
Disallow: /admin/
```

Il reference aussi le sitemap public.

Les pages admin gardent egalement des metadonnees `noindex, nofollow`.

## Sitemap

Le sitemap minimal est:

```text
front/app/sitemap.ts
```

Il contient uniquement:

```text
https://eszter-gyori.vercel.app/
```

Il exclut `/admin`, `/admin/login`, `/admin/preview`, les routes d'action auth, les ancres, les URLs API et les domaines de preview.

## Donnees structurees reportees

Aucun JSON-LD `LocalBusiness`, `BeautySalon`, `Person` ou schema similaire n'est ajoute pour l'instant.

Champs a valider avant une future passe:

- nom legal;
- adresse postale;
- telephone;
- horaires;
- prix;
- coordonnees geographiques;
- URL de reservation;
- profils sociaux officiels.

## Remplacement futur de l'image sociale

Lorsque des photographies finales et validees seront disponibles, l'image sociale pourra etre remplacee par une composition basee sur ces assets, a condition de conserver:

- lisibilite a petite taille;
- marges de securite;
- contraste suffisant;
- absence de claims non verifies;
- absence d'impact sur le rendu normal de `/`.

## Validation

Commandes techniques:

```powershell
cd E:\Eszter\front
npm ci
npm run test
npm run lint
npm run build
```

Validation runtime:

```text
/
/robots.txt
/sitemap.xml
/manifest.webmanifest
/icon.svg
/apple-icon
/opengraph-image
/admin
/admin/login
/admin/preview
```
