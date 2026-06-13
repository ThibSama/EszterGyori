# Eszter Frontend

Application Next.js publique et prototype `/admin` local.

Le frontend depend du package partage local `@eszter/contracts`, situe dans `../contracts`. Vercel doit donc construire avec le depot complet comme contexte et garder `front` comme Root Directory.

## Commandes

```powershell
npm install
npm run lint
npm run build
npm run start
```

## Contenu public

La page `/` charge le contenu publie cote serveur via `CONTENT_API_URL` quand la variable est configuree.

```text
CONTENT_API_URL=https://api.example.com/api/content
```

Cette variable est server-only :

- ne pas utiliser de prefixe `NEXT_PUBLIC_` ;
- fournir l'URL complete incluant `/api/content` ;
- ne pas exposer la valeur au navigateur ;
- ne pas la rendre obligatoire pour le build Vercel.

Si la variable est absente, invalide, si l'API est indisponible, ou si la reponse ne valide pas `PublishedContentEnvelopeV1`, la page utilise `defaultSiteContent`.

La revalidation Next.js est de 60 secondes.

## Admin

`/admin` reste local-only :

- edition en memoire ;
- brouillon `localStorage` ;
- import/export JSON ;
- aucun appel API ;
- aucune authentification.

## Vercel

Le Root Directory Vercel doit rester :

```text
front
```

Apres deploiement public de l'API :

```text
Project Settings
-> Environment Variables
-> CONTENT_API_URL
-> https://<public-api-domain>/api/content
```

Tant que cette variable n'est pas configuree, la production continue de rendre `defaultSiteContent`.

## API Docker

Le frontend n'est pas dockerise dans cette passe. L'image Docker concerne uniquement `API/`.

Quand l'API sera deployee publiquement, Vercel devra conserver `front` comme Root Directory et recevoir la variable server-only :

```text
CONTENT_API_URL=https://<public-api-domain>/api/content
```

Sans cette variable, le frontend continue d'utiliser le fallback `defaultSiteContent`.
