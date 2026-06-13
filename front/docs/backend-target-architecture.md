# Architecture cible — partiellement bootstrappée

Ce document décrit la direction backend prévue pour le CMS Eszter. Il distingue explicitement ce qui existe déjà de ce qui reste à implémenter.

## Statut actuel

Implémenté :

- package Express TypeScript indépendant dans `server/` ;
- import du contrat partagé `contracts/` ;
- validation de configuration serveur avec Zod ;
- endpoint `GET /api/health` ;
- erreurs JSON de base ;
- IDs de requête ;
- arrêt gracieux ;
- tests ciblés du bootstrap serveur.

Non implémenté :

- API de contenu ;
- brouillon serveur ;
- contenu publié serveur ;
- publication ;
- authentification ;
- cookies ou sessions ;
- CSRF ;
- stockage JSON serveur ;
- base de données ;
- upload média ;
- Docker ;
- reverse proxy ;
- intégration du frontend avec l'API.

## Objectif cible

Ajouter plus tard un service Express TypeScript capable de gérer un brouillon serveur, du contenu publié, une authentification administrateur, une publication explicite et des uploads médias sécurisés.

Le service actuel est uniquement un bootstrap technique. Il ne prouve pas encore que le stockage de contenu, les volumes médias ou l'authentification sont prêts.

## Topologie recommandée

Déploiement recommandé en même origine :

```text
https://site.example/        -> Next.js
https://site.example/api/*   -> Express
https://site.example/media/* -> médias servis depuis un volume persistant
```

Cette topologie permet d'éviter le CORS authentifié et simplifie les cookies de session.

## Service Express TypeScript

Le service Express doit progressivement :

- importer les schémas depuis `contracts/` ;
- exposer les routes sous `/api` ;
- valider toutes les entrées HTTP au runtime ;
- retourner des erreurs JSON structurées ;
- journaliser les erreurs serveur sans exposer de stack trace au frontend ;
- conserver `GET /api/health` comme endpoint de liveness.

## Cycle de vie du contenu

Modèle cible :

```text
defaultSiteContent
  -> seed/fallback
server draft
  -> sauvegardes admin non publiques
published content
  -> contenu servi au site public
```

Sauver un brouillon serveur ne doit pas modifier le site public. La publication doit être une action explicite qui copie un brouillon validé vers le contenu publié.

`defaultSiteContent` doit rester une source de seed et un fallback si le backend ou le stockage publié est indisponible.

## API cible minimale

Routes proposées pour des passes futures :

- `GET /api/content` : lire le contenu publié.
- `GET /api/admin/content/draft` : lire le brouillon serveur authentifié.
- `PUT /api/admin/content/draft` : sauvegarder un brouillon avec contrôle de révision.
- `POST /api/admin/content/publish` : publier explicitement le brouillon courant.
- `POST /api/admin/content/reset` : recréer le brouillon depuis le contenu par défaut ou publié.
- `POST /api/admin/media` : uploader un média.
- `DELETE /api/admin/media/:id` : supprimer un média non référencé.
- `POST /api/auth/login` : ouvrir une session.
- `POST /api/auth/logout` : fermer une session.
- `GET /api/auth/session` : vérifier la session.

Ces routes ne sont pas encore implémentées.

## Enveloppes de contenu

Les enveloppes préparées dans `contracts/content-envelopes.ts` sont :

- `SiteContentDraftV1` pour le brouillon local actuel ;
- `ServerDraftEnvelopeV1` pour un futur brouillon serveur ;
- `PublishedContentEnvelopeV1` pour un futur contenu publié.

Les enveloppes serveur doivent utiliser `schemaVersion: 1`, une révision entière positive ou égale à zéro et un timestamp ISO valide.

## Concurrence

Le futur backend doit utiliser une concurrence optimiste :

- chaque brouillon serveur a une `revision` ;
- le client envoie la révision courante, idéalement aussi via `If-Match` ;
- le serveur répond `409` si la révision est obsolète ;
- l'interface admin propose alors de recharger le brouillon serveur ou d'exporter le travail local.

## Stockage MVP

Stockage recommandé pour le MVP :

- fichiers JSON atomiques sur volume persistant ;
- un fichier pour le brouillon serveur ;
- un fichier pour le contenu publié ;
- un petit historique de publications ;
- un manifeste média.

Les écritures doivent utiliser fichier temporaire puis renommage atomique.

Chemin de migration si le projet grandit : SQLite pour transactions, historique plus riche et sessions persistantes ; stockage objet compatible S3 pour les médias si le disque local n'est pas durable.

## Authentification

Modèle recommandé :

- un administrateur ;
- mot de passe hashé avec Argon2id ou bcrypt ;
- sessions serveur ;
- cookie `HttpOnly`, `Secure` en production, `SameSite=Lax` ou `Strict`, `Path=/` ;
- expiration courte à moyenne ;
- logout qui invalide la session serveur et expire le cookie ;
- rate limiting sur login ;
- aucun token dans l'URL ou dans `localStorage`.

## CSRF et CORS

En même origine, CORS peut rester désactivé.

Toutes les routes admin mutantes devront vérifier :

- session valide ;
- token CSRF ;
- méthode HTTP attendue ;
- `Content-Type` attendu.

Ne jamais configurer de CORS wildcard pour des routes authentifiées.

## Upload média

Le futur upload doit :

- accepter `multipart/form-data` ;
- limiter la taille, par exemple 5 Mo au MVP ;
- accepter uniquement JPEG, PNG et WebP au départ ;
- vérifier extension, MIME déclaré, sniffing et décodage réel ;
- ne jamais faire confiance au nom de fichier original ;
- générer un nom de fichier serveur ;
- empêcher le path traversal ;
- strip EXIF ;
- compresser en WebP ;
- stocker dans un volume persistant ;
- retourner une URL publique de type `/media/...` ;
- refuser la suppression d'un média encore référencé ou le soft-delete ;
- nettoyer les fichiers orphelins.

## Intégration du site public

À terme, le frontend public devrait charger le contenu publié côté serveur pour préserver SEO et rendu initial rapide.

En cas d'échec de l'API ou du stockage publié, le frontend doit utiliser `defaultSiteContent` comme fallback contrôlé.

Une publication devra invalider le cache public ou déclencher une revalidation.

## Sauvegardes

Les sauvegardes devront inclure ensemble :

- brouillon serveur ;
- contenu publié ;
- historique de publication ;
- manifeste média ;
- fichiers médias.

La restauration devra être testée avant mise en production.

## Prochaine passe recommandée

La plus petite passe backend utile après le bootstrap consiste à créer un module de stockage JSON atomique, sans route HTTP de contenu, sans authentification, sans publication et sans upload.
