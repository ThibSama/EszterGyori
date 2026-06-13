# Eszter API

Service Express TypeScript minimal pour le futur backend CMS Eszter.

Le service expose actuellement `GET /api/health` et `GET /api/content`. Le contenu public est lu depuis `published.json`. Aucune route d'ecriture, de brouillon admin ou de publication n'existe encore.

## Emplacement

```text
E:\Eszter\API
```

Structure :

```text
API/
├── src/
│   └── storage/
├── tests/
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Installation et commandes

Depuis `E:\Eszter\API` :

```powershell
npm install
npm run dev
npm run typecheck
npm run build
npm run test
npm run start
```

`npm run start` lance le build de production `dist/index.js`.

## Configuration

Variables supportees :

| Variable | Defaut | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` ou `production` |
| `HOST` | `127.0.0.1` | Adresse d'ecoute |
| `PORT` | `4000` | Port TCP de `1` a `65535` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CONTENT_DATA_DIR` | `E:\Eszter\API\data` | Repertoire des fichiers JSON de contenu |

`CONTENT_DATA_DIR` est optionnel. Un chemin relatif est resolu depuis `E:\Eszter\API`. Un chemin absolu est conserve. Une valeur vide est rejetee.

## Stockage JSON

Le stockage cree exactement deux fichiers dans `CONTENT_DATA_DIR` :

```text
draft.json
published.json
```

Si un fichier manque, il est initialise depuis `defaultSiteContent`, exporte par le package partage racine `@eszter/contracts`.

Enveloppe initiale du brouillon :

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "updatedAt": "date ISO",
  "content": {}
}
```

Enveloppe initiale du contenu publie :

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "publishedAt": "date ISO",
  "content": {}
}
```

Les fichiers existants sont toujours valides au demarrage. Un fichier invalide, malforme, trop volumineux ou incompatible fait echouer le demarrage. Le service ne remplace jamais silencieusement une donnee invalide par le contenu par defaut.

## Ecritures atomiques

Les ecritures JSON utilisent :

- un fichier temporaire cree dans le meme dossier ;
- une ouverture exclusive ;
- une serialisation JSON avec indentation de deux espaces ;
- un flush disque via `sync` ;
- un renommage vers `draft.json` ou `published.json` ;
- un nettoyage du temporaire en cas d'erreur.

Les ecritures sont serialisees dans le processus Node courant. Le MVP ne fournit pas encore de verrou distribue ni de support multi-instance.

## Demarrage

Ordre de demarrage :

```text
configuration
→ stockage JSON
→ validation ou seed
→ creation Express
→ listen
```

Aucun port n'est ouvert si le stockage ne peut pas etre initialise ou valide.

## Endpoints disponibles

```http
GET /api/health
```

Reponse exemple :

```json
{
  "status": "ok",
  "service": "eszter-api",
  "contentSchemaVersion": 1,
  "timestamp": "2026-06-13T12:00:00.000Z",
  "uptimeSeconds": 12
}
```

Le healthcheck reste un endpoint de liveness. Il ne retourne pas les chemins, revisions ou contenus stockes.

```http
GET /api/content
```

Retourne l'enveloppe complete `PublishedContentEnvelopeV1` lue depuis `published.json`.

Headers :

- `ETag: "published-<revision>"`
- `Cache-Control: public, max-age=0, must-revalidate`
- `X-Request-Id: req_...`

La route supporte `If-None-Match`. Si l'ETag courant correspond, elle retourne `304` sans corps JSON.

En cas d'erreur de stockage ou de validation de reponse, la route retourne :

```json
{
  "error": {
    "code": "STORAGE_FAILURE",
    "message": "Le contenu publié est momentanément indisponible.",
    "requestId": "req_..."
  }
}
```

Le brouillon serveur n'est jamais expose par cette route.

Le frontend Next.js peut consommer cette route cote serveur avec la variable server-only `CONTENT_API_URL`. Cette variable doit contenir l'URL complete, par exemple `https://api.example.com/api/content`, et ne doit pas utiliser le prefixe `NEXT_PUBLIC_`.

## Limites actuelles

Non implemente :

- endpoint de brouillon serveur ;
- endpoint d'ecriture de brouillon ;
- publication ;
- reset ;
- authentification ;
- cookies, sessions ou CSRF ;
- upload media ;
- base de donnees ;
- historique ou rollback ;
- sauvegarde automatisee ;
- integration admin ou ecriture frontend.

## Contrat partage

L'API depend du package local `@eszter/contracts`, situe dans `E:\Eszter\contracts`.

Depuis `E:\Eszter\API`, `npm install` installe ce package via `file:../contracts`. Construire `@eszter/contracts` produit `contracts/dist/`, que l'API bundle ensuite dans `API/dist/index.js`. Le build API externalise seulement les dependances runtime npm necessaires comme `express` et `zod`.

Le package `@eszter/contracts` est la source unique pour :

- `defaultSiteContent` ;
- `SITE_CONTENT_SCHEMA_VERSION` ;
- les schemas `SiteContent` et enveloppes versionnees ;
- les types TypeScript inferes.

## Image Docker production

Le Dockerfile de l'API se trouve dans :

```text
API/Dockerfile
```

Le contexte de build doit etre la racine du depot, car l'API depend du package sibling `contracts/` :

```powershell
cd E:\Eszter
docker build -f API/Dockerfile -t eszter-api:local .
```

L'image :

- construit `@eszter/contracts` dans une etape dediee ;
- construit le bundle API `API/dist/index.js` ;
- installe seulement les dependances runtime de production ;
- execute `node dist/index.js` sans `tsx`, TypeScript ni esbuild ;
- tourne avec l'utilisateur non-root `node` ;
- ecoute `0.0.0.0:4000` ;
- configure `CONTENT_DATA_DIR=/data` ;
- declare le volume `/data` ;
- expose uniquement le port `4000` ;
- fournit un healthcheck Docker sur `GET /api/health`.

Exemple local avec volume nomme :

```powershell
docker volume create eszter-api-data
docker run -d `
  --name eszter-api-test `
  -p 4000:4000 `
  -v eszter-api-data:/data `
  eszter-api:local
```

Validation rapide :

```powershell
curl.exe http://127.0.0.1:4000/api/health
curl.exe http://127.0.0.1:4000/api/content
docker stop --time 10 eszter-api-test
```

Exemple avec filesystem racine en lecture seule :

```powershell
docker run -d `
  --name eszter-api-readonly `
  --read-only `
  --tmpfs /tmp `
  -p 4000:4000 `
  -v eszter-api-data:/data `
  eszter-api:local
```

Le stockage JSON reste single-process. La persistance depend d'un vrai volume monte sur `/data`. Il n'y a pas encore de sauvegarde automatisee, de reverse proxy, de terminaison HTTPS, d'authentification, de publication ni d'upload media.
