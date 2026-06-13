# Architecture cible - partiellement bootstrappee

Ce document decrit la direction backend prevue pour le CMS Eszter. Il distingue ce qui existe deja de ce qui reste a implementer.

## Statut actuel

Implemente :

- package Express TypeScript independant dans `API/` ;
- import du contrat partage temporairement situe dans `front/contracts/` ;
- validation de configuration serveur avec Zod ;
- endpoint `GET /api/health` ;
- erreurs JSON de base ;
- IDs de requete ;
- arret gracieux ;
- tests cibles du bootstrap serveur.

Non implemente :

- API de contenu ;
- brouillon serveur ;
- contenu publie serveur ;
- publication ;
- authentification ;
- cookies ou sessions ;
- CSRF ;
- stockage JSON serveur ;
- base de donnees ;
- upload media ;
- Docker ;
- reverse proxy ;
- integration du frontend avec l'API.

## Objectif cible

Ajouter plus tard un service Express TypeScript capable de gerer un brouillon serveur, du contenu publie, une authentification administrateur, une publication explicite et des uploads medias securises.

Le service actuel est uniquement un bootstrap technique. Il ne prouve pas encore que le stockage de contenu, les volumes medias ou l'authentification sont prets.

## Topologie recommandee

Deploiement recommande en meme origine :

```text
https://site.example/        -> Next.js
https://site.example/api/*   -> Express
https://site.example/media/* -> medias servis depuis un volume persistant
```

Cette topologie permet d'eviter le CORS authentifie et simplifie les cookies de session.

## Service Express TypeScript

Le service Express doit progressivement :

- importer les schemas depuis un futur package partage racine ;
- exposer les routes sous `/api` ;
- valider toutes les entrees HTTP au runtime ;
- retourner des erreurs JSON structurees ;
- journaliser les erreurs serveur sans exposer de stack trace au frontend ;
- conserver `GET /api/health` comme endpoint de liveness.

## Cycle de vie du contenu

Modele cible :

```text
defaultSiteContent
  -> seed/fallback
server draft
  -> sauvegardes admin non publiques
published content
  -> contenu servi au site public
```

Sauver un brouillon serveur ne doit pas modifier le site public. La publication doit etre une action explicite qui copie un brouillon valide vers le contenu publie.

## API cible minimale

Routes proposees pour des passes futures :

- `GET /api/content` : lire le contenu publie.
- `GET /api/admin/content/draft` : lire le brouillon serveur authentifie.
- `PUT /api/admin/content/draft` : sauvegarder un brouillon avec controle de revision.
- `POST /api/admin/content/publish` : publier explicitement le brouillon courant.
- `POST /api/admin/content/reset` : recreer le brouillon depuis le contenu par defaut ou publie.
- `POST /api/admin/media` : uploader un media.
- `DELETE /api/admin/media/:id` : supprimer un media non reference.
- `POST /api/auth/login` : ouvrir une session.
- `POST /api/auth/logout` : fermer une session.
- `GET /api/auth/session` : verifier la session.

Ces routes ne sont pas encore implementees.

## Prochaine passe recommandee

La plus petite passe backend utile apres le bootstrap consiste a creer un module de stockage JSON atomique, sans route HTTP de contenu, sans authentification, sans publication et sans upload.
