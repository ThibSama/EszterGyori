# Architecture de contenu actuelle

Ce document decrit l'etat actuel du depot Eszter.

## Applications

- `front/` contient l'application Next.js publique et l'admin frontend local.
- `API/` contient le service Express TypeScript minimal.
- `contracts/` contient le package prive partage `@eszter/contracts`.

Le service Express expose `GET /api/health` et `GET /api/content`.

La homepage publique peut consommer `GET /api/content` cote serveur via `CONTENT_API_URL`. `/admin` ne consomme pas l'API.

## Contrat partage

Le contrat de contenu runtime est defini dans le package partage racine `contracts/`.

- `contracts/site-content.ts` contient les schemas Zod stricts du contenu du site.
- `contracts/content-envelopes.ts` contient les enveloppes versionnees.
- `contracts/default-site-content.ts` contient la valeur canonique `defaultSiteContent`.
- `contracts/index.ts` re-exporte les schemas, constantes et types.
- `contracts/package.json` expose ces exports sous le nom `@eszter/contracts`.

`front/app/content/default-site-content.ts` reste un fichier de compatibilite qui re-exporte la valeur par defaut pour le frontend.

Le frontend et l'API declarent tous deux `@eszter/contracts` via une dependance locale `file:../contracts`.

## Rendu public

`front/app/page.tsx` charge le contenu public avec `front/app/lib/server/public-content.ts`.

Si `CONTENT_API_URL` est configure et valide, la page appelle l'URL complete `GET /api/content`, valide l'enveloppe `PublishedContentEnvelopeV1`, puis rend `envelope.content`.

Si la variable est absente, invalide, si l'API echoue, ou si la reponse ne valide pas le schema, la page rend `defaultSiteContent`.

La revalidation Next.js est de 60 secondes. L'URL API reste server-only et n'est pas exposee au navigateur.

Le rendu final passe toujours seulement le contenu a la presentation :

```tsx
<SitePreview content={content} />
```

Le site public ne lit pas `localStorage` et ne consomme pas de brouillon admin.

## Administration frontend

La route `/admin` existe et fournit un editeur frontend local.

L'editeur :

- initialise son etat depuis une copie de `defaultSiteContent` ;
- permet de modifier les textes, URLs editables, sources medias et textes alternatifs ;
- affiche un apercu via le meme `SitePreview` que le site public ;
- conserve l'ordre, le nombre d'items, les IDs techniques et la structure des sections ;
- n'appelle pas `GET /api/content`.

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

Le package `API/` :

- importe le contrat partage depuis `@eszter/contracts` ;
- initialise `API/data/draft.json` et `API/data/published.json` par defaut ;
- valide les fichiers JSON au demarrage avant d'ouvrir le port ;
- expose `GET /api/health` ;
- expose `GET /api/content`, public et read-only, qui retourne `PublishedContentEnvelopeV1` depuis `published.json` ;
- gere un ETag `"published-<revision>"` et `If-None-Match` ;
- retourne des erreurs JSON de base ;
- gere l'arret gracieux ;
- dispose d'un Dockerfile production qui utilise `/data` comme volume persistant.

## Docker API

L'image API se construit depuis la racine du depot :

```powershell
docker build -f API/Dockerfile -t eszter-api:local .
```

Le conteneur ecoute `0.0.0.0:4000`, tourne en utilisateur non-root, utilise `CONTENT_DATA_DIR=/data` et expose un healthcheck Docker sur `GET /api/health`.

Le stockage persistant depend d'un volume Docker ou d'un volume fourni par l'hebergeur. Aucun fournisseur, reverse proxy, HTTPS, backup automatise ou monitoring n'est configure dans ce depot.

## Vercel

Le Root Directory Vercel reste :

```text
front
```

Apres deploiement public de l'API, configurer :

```text
CONTENT_API_URL=https://<public-api-domain>/api/content
```

Sans cette variable, la production rend `defaultSiteContent`.

## Fonctionnalites non encore presentes

Le projet ne contient pas encore :

- endpoint de brouillon serveur ;
- endpoint d'ecriture de brouillon ;
- publication ;
- authentification ;
- cookies ou sessions ;
- base de donnees ;
- routes HTTP d'ecriture de ce stockage ;
- stockage serveur d'images ;
- upload reel ;
- reverse proxy ;
- HTTPS ;
- sauvegarde automatisee ;
- monitoring.
