# Architecture de contenu actuelle

Ce document décrit l'état actuel du dépôt Eszter.

## Contrat partagé

Le contrat de contenu runtime est défini dans `contracts/`.

- `contracts/site-content.ts` contient les schémas Zod stricts du contenu du site.
- `contracts/content-envelopes.ts` contient les enveloppes versionnées.
- `contracts/index.ts` ré-exporte les schémas, constantes et types.

`app/types/site-content.ts` conserve les imports frontend existants en ré-exportant les types inférés depuis `contracts/`.

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

Les collections répétées conservent un nombre, un ordre et des IDs techniques fixes. Les schémas rejettent les champs inconnus, les sections manquantes, les mauvais types, les IDs modifiés, les items ajoutés ou supprimés et les URLs dangereuses.

Les médias utilisent `MediaAsset` avec :

- `id`
- `src: string | null`
- `alt`

Le contenu par défaut conserve actuellement des placeholders CSS : les `src` médias valent `null`.

## Source par défaut

Le contenu de référence est stocké dans `app/content/default-site-content.ts`.

Ce fichier exporte :

- `defaultSiteContent`, typé en `SiteContent`
- `getDefaultSiteContent()`

`defaultSiteContent` est validé au chargement du module avec `siteContentSchema.parse(defaultSiteContent)`, ce qui permet de détecter une structure invalide pendant le développement ou le build.

## Rendu public

`app/page.tsx` rend toujours :

```tsx
<SitePreview content={getDefaultSiteContent()} />
```

Le site public ne lit pas `localStorage`, ne consomme pas de brouillon admin et ne charge pas de contenu depuis une API.

## Administration frontend

La route `/admin` existe et fournit un éditeur frontend local.

L'éditeur :

- initialise son état depuis une copie de `defaultSiteContent` ;
- permet de modifier les textes, URLs éditables, sources médias et textes alternatifs ;
- affiche un aperçu via le même `SitePreview` que le site public ;
- conserve l'ordre, le nombre d'items, les IDs techniques et la structure des sections.

## Brouillon local et JSON

Le brouillon local utilise `localStorage` sous la clé :

```text
eszter:admin-content-draft:v1
```

Le format courant est :

```ts
interface SiteContentDraftV1 {
  schemaVersion: 1;
  savedAt: string;
  content: SiteContent;
}
```

L'admin permet :

- l'enregistrement explicite du brouillon local ;
- la restauration au rechargement de `/admin` ;
- la suppression du brouillon local ;
- l'export JSON versionné ;
- l'import JSON avec validation runtime ;
- le reset vers `defaultSiteContent`.

Ces opérations restent locales au navigateur et ne publient pas le site public.

## Service Express actuel

Le dépôt contient maintenant un package Express TypeScript minimal dans `server/`.

Ce service :

- importe le contrat partagé depuis `contracts/` ;
- valide sa configuration au démarrage ;
- expose uniquement `GET /api/health` ;
- retourne des erreurs JSON de base ;
- gère l'arrêt gracieux.

Le frontend public et `/admin` ne consomment pas ce service.

## Éléments fixes dans le code

Restent volontairement codés dans les composants :

- l'ordre des sections ;
- les ancres de sections ;
- les layouts, classes CSS, gradients, animations et breakpoints ;
- la logique du menu mobile ;
- la logique du bouton Instagram hero ;
- les comportements techniques non éditables.

## Fonctionnalités non encore présentes

Le projet ne contient pas encore :

- endpoint de contenu public ;
- brouillon serveur ;
- publication ;
- authentification ;
- cookies ou sessions ;
- base de données ;
- stockage JSON serveur ;
- stockage serveur d'images ;
- upload réel ;
- Docker ou reverse proxy ;
- intégration du frontend avec l'API Express.
