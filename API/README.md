# Eszter API

Service Express TypeScript minimal pour le futur backend CMS Eszter.

Cette passe expose uniquement `GET /api/health`. Le service ne fournit pas encore d'API de contenu, d'authentification, de stockage serveur, de publication ou d'upload media.

## Emplacement

Le package backend vit a la racine du projet :

```text
E:\Eszter\API
```

Structure :

```text
API/
├── src/
├── tests/
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Installation

Depuis `E:\Eszter\API` :

```powershell
cd E:\Eszter\API
npm install
```

## Commandes

```powershell
npm run dev
npm run typecheck
npm run build
npm run test
npm run start
```

- `dev` lance le service TypeScript en developpement.
- `typecheck` verifie TypeScript sans emettre de fichiers.
- `build` verifie TypeScript puis genere `dist/index.js`.
- `test` execute les tests avec `node:test` via `tsx`.
- `start` lance le build de production.

## Configuration

Variables supportees pour cette passe :

| Variable | Defaut | Valeurs acceptees |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `HOST` | `127.0.0.1` | chaine non vide |
| `PORT` | `4000` | entier TCP de `1` a `65535` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

La configuration est validee avec Zod au demarrage. Une valeur invalide empeche le demarrage avec un code de sortie non nul.

## Endpoint disponible

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

`contentSchemaVersion` vient du contrat partage et n'est pas duplique dans l'API.

Le serveur retourne aussi :

- `404 NOT_FOUND` en JSON pour les routes inconnues ;
- `405 METHOD_NOT_ALLOWED` en JSON pour les methodes non supportees sur `/api/health` ;
- `400 INVALID_JSON` en JSON pour un corps JSON malforme ;
- `500 INTERNAL_ERROR` en JSON pour une erreur inattendue.

Chaque reponse contient un en-tete `X-Request-Id`.

## Contrat partage

Les contrats restent temporairement sous :

```text
E:\Eszter\front\contracts
```

L'API les importe depuis ce chemin reel. Une passe dediee pourra ensuite extraire `contracts/` en package partage racine.

## Limites actuelles

Non implemente dans cette passe :

- API de contenu ;
- brouillon serveur ;
- publication ;
- authentification ;
- cookies, sessions ou CSRF ;
- base de donnees ;
- stockage JSON serveur ;
- upload media ;
- Docker ;
- reverse proxy ;
- integration frontend.
