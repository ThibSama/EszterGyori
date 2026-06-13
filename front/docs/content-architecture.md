# Architecture de contenu actuelle

Ce document decrit l'etat actuel du depot Eszter.

## Applications

- `front/` contient l'application Next.js publique et l'admin frontend local.
- `API/` contient le service Express TypeScript minimal.
- `front/contracts/` contient temporairement le contrat runtime partage.

Le service Express expose uniquement `GET /api/health`. Le frontend public et `/admin` ne consomment pas encore l'API.

## Contrat partage

Le contrat de contenu runtime est defini temporairement dans `front/contracts/`.

- `front/contracts/site-content.ts` contient les schemas Zod stricts du contenu du site.
- `front/contracts/content-envelopes.ts` contient les enveloppes versionnees.
- `front/contracts/index.ts` re-exporte les schemas, constantes et types.

`front/app/types/site-content.ts` conserve les imports frontend existants en re-exportant les types inferes depuis le contrat.

Une passe dediee pourra plus tard extraire ce contrat dans un vrai package partage racine.

## Structure du contenu

Le type racine `SiteContent` contient les sections fixes suivantes :

- `navigation`
- `hero`
- `reassurance`
- `services`
- `process`
- `gallery`
- `about`
- `contact`
- `footer`

Les collections repetees conservent un nombre, un ordre et des IDs techniques fixes. Les schemas rejettent les champs inconnus, les sections manquantes, les mauvais types, les IDs modifies, les items ajoutes ou supprimes et les URLs dangereuses.

Les medias utilisent `MediaAsset` avec :

- `id`
- `src: string | null`
- `alt`

## Source par defaut

Le contenu de reference est stocke dans `front/app/content/default-site-content.ts`.

Ce fichier exporte :

- `defaultSiteContent`, type en `SiteContent`
- `getDefaultSiteContent()`

`defaultSiteContent` est valide au chargement du module avec `siteContentSchema.parse(defaultSiteContent)`.

## Rendu public

`front/app/page.tsx` rend toujours :

```tsx
<SitePreview content={getDefaultSiteContent()} />
```

Le site public ne lit pas `localStorage`, ne consomme pas de brouillon admin et ne charge pas de contenu depuis une API.

## Administration frontend

La route `/admin` existe et fournit un editeur frontend local.

L'editeur :

- initialise son etat depuis une copie de `defaultSiteContent` ;
- permet de modifier les textes, URLs editables, sources medias et textes alternatifs ;
- affiche un apercu via le meme `SitePreview` que le site public ;
- conserve l'ordre, le nombre d'items, les IDs techniques et la structure des sections.

## Brouillon local et JSON

Le brouillon local utilise `localStorage` sous la cle :

```text
eszter:admin-content-draft:v1
```

L'admin permet :

- l'enregistrement explicite du brouillon local ;
- la restauration au rechargement de `/admin` ;
- la suppression du brouillon local ;
- l'export JSON versionne ;
- l'import JSON avec validation runtime ;
- le reset vers `defaultSiteContent`.

Ces operations restent locales au navigateur et ne publient pas le site public.

## Service Express actuel

Le depot contient un package Express TypeScript minimal dans `API/`.

Ce service :

- importe le contrat partage depuis `front/contracts/` ;
- valide sa configuration au demarrage ;
- expose uniquement `GET /api/health` ;
- retourne des erreurs JSON de base ;
- gere l'arret gracieux.

## Fonctionnalites non encore presentes

Le projet ne contient pas encore :

- endpoint de contenu public ;
- brouillon serveur ;
- publication ;
- authentification ;
- cookies ou sessions ;
- base de donnees ;
- stockage JSON serveur ;
- stockage serveur d'images ;
- upload reel ;
- Docker ou reverse proxy ;
- integration du frontend avec l'API Express.
