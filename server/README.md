# Eszter API

Service Express TypeScript minimal pour le futur backend CMS Eszter.

Cette passe implémente uniquement le bootstrap serveur et le point de santé `GET /api/health`. Le service ne fournit pas encore d'API de contenu, d'authentification, de stockage serveur, de publication ou d'upload média.

## Structure

```text
server/
├── src/
│   ├── app.ts
│   ├── config.ts
│   ├── http-error.ts
│   ├── index.ts
│   ├── request-id.ts
│   └── server.ts
├── tests/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## Installation

Depuis `server/` :

```bash
npm install
```

## Commandes

```bash
npm run dev
npm run typecheck
npm run build
npm run test
npm run start
```

- `dev` lance le service TypeScript en développement.
- `typecheck` vérifie TypeScript sans émettre de fichiers.
- `build` vérifie TypeScript puis génère `dist/index.js`.
- `test` exécute les tests avec `node:test` via `tsx`.
- `start` lance le build de production.

## Configuration

Variables supportées pour cette passe :

| Variable | Défaut | Valeurs acceptées |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `HOST` | `127.0.0.1` | chaîne non vide |
| `PORT` | `4000` | entier TCP de `1` à `65535` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

La configuration est validée avec Zod au démarrage. Une valeur invalide empêche le démarrage avec un code de sortie non nul.

## Endpoint disponible

```http
GET /api/health
```

Réponse exemple :

```json
{
  "status": "ok",
  "service": "eszter-api",
  "contentSchemaVersion": 1,
  "timestamp": "2026-06-13T12:00:00.000Z",
  "uptimeSeconds": 12
}
```

`contentSchemaVersion` vient du contrat partagé `contracts/` et n'est pas dupliqué dans le serveur.

Le serveur retourne aussi :

- `404 NOT_FOUND` en JSON pour les routes inconnues ;
- `405 METHOD_NOT_ALLOWED` en JSON pour les méthodes non supportées sur `/api/health` ;
- `400 INVALID_JSON` en JSON pour un corps JSON malformé ;
- `500 INTERNAL_ERROR` en JSON pour une erreur inattendue.

Chaque réponse contient un en-tête `X-Request-Id`.

## Contrat partagé

Le service importe le contrat depuis le répertoire racine `contracts/`. Le build production utilise `esbuild` pour inclure ce code TypeScript local dans `dist/index.js`, tout en laissant les dépendances npm externes.

Il n'existe pas de copie du contrat dans `server/`.

## Limites actuelles

Non implémenté dans cette passe :

- API de contenu ;
- brouillon serveur ;
- publication ;
- authentification ;
- cookies, sessions ou CSRF ;
- base de données ;
- stockage JSON serveur ;
- upload média ;
- Docker ;
- reverse proxy ;
- intégration frontend.
