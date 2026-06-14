# Architecture cible - partiellement bootstrappee

Ce document decrit la direction backend prevue pour le CMS Eszter.

## Statut actuel

Implemente :

- package Express TypeScript independant dans `API/` ;
- import du contrat partage depuis le package racine `@eszter/contracts` ;
- validation de configuration serveur avec Zod ;
- endpoint `GET /api/health` ;
- endpoint public read-only `GET /api/content` ;
- stockage JSON local `draft.json` et `published.json` ;
- initialisation depuis `contracts/default-site-content.ts` via `@eszter/contracts` ;
- contrat `SiteContent.appearance` avec palette globale, teintes de sections, validation hex et contraste ;
- ecritures atomiques par fichier temporaire puis renommage ;
- validation du stockage avant ouverture du port ;
- integration serveur Next.js de la homepage via `CONTENT_API_URL` ;
- protection frontend de `/admin` via `/admin/login` et session signee ;
- fallback controle vers `defaultSiteContent` ;
- erreurs JSON de base ;
- IDs de requete ;
- arret gracieux ;
- tests cibles ;
- Dockerfile production pour `API/` ;
- runtime conteneur non-root ;
- contrat de volume persistant `/data` ;
- healthcheck Docker sur `GET /api/health`.

Non implemente :

- endpoint de brouillon serveur ;
- endpoint d'ecriture de brouillon ;
- publication ;
- authentification Express ;
- sessions API ;
- CSRF ;
- base de donnees ;
- upload media ;
- reverse proxy ;
- workflow de backup ou rollback ;
- deploiement chez un fournisseur ;
- monitoring.
- API admin, publication et upload media pour l'apparence.

## Docker API actuel

L'image API se construit depuis la racine du depot :

```powershell
cd E:\Eszter
docker build -f API/Dockerfile -t eszter-api:local .
```

Le build compile d'abord `contracts/`, puis l'API. Le conteneur final execute `node dist/index.js` avec :

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=4000
CONTENT_DATA_DIR=/data
```

`/data` est declare comme volume et doit etre fourni par l'hebergeur ou par Docker. Le healthcheck Docker appelle `http://127.0.0.1:4000/api/health`.

Le conteneur ne fournit pas de reverse proxy, pas de HTTPS interne, pas de sauvegarde automatisee et pas de support multi-instance pour le stockage JSON.

## Integration frontend actuelle

Le frontend utilise une variable server-only optionnelle :

```text
CONTENT_API_URL=https://<public-api-domain>/api/content
```

La valeur doit contenir l'URL complete de `GET /api/content`. Elle ne doit pas utiliser `NEXT_PUBLIC_`.

Le fetch est effectue cote serveur par Next.js avec une revalidation de 60 secondes. Le navigateur ne recoit pas l'URL API et ne fait pas de requete directe vers l'API.

Sans cette variable, ou en cas d'erreur API/schema, la page publique rend `defaultSiteContent`. `/admin` reste local-only.

Le contenu publie peut maintenant contenir `appearance`. Les anciens `draft.json` et `published.json` sans ce champ sont acceptes et normalises en memoire avec `defaultSiteAppearance`, sans reecriture silencieuse au demarrage. Les futures mutations serveur devront incrementer la revision lorsqu'elles modifient texte ou apparence afin de conserver la validite des ETags `"published-<revision>"`.

`/admin` est protege cote Next.js par une session signee, mais cette protection ne doit pas servir d'autorisation pour de futures routes Express. Toute route API de mutation devra verifier une authentification/autorisation backend independante.

## Cycle de vie cible

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

Routes :

- `GET /api/content` : lire le contenu publie. Implementee.
- `GET /api/admin/content/draft` : lire le brouillon serveur authentifie. Non implementee.
- `PUT /api/admin/content/draft` : sauvegarder un brouillon avec controle de revision. Non implementee.
- `POST /api/admin/content/publish` : publier explicitement le brouillon courant. Non implementee.
- `POST /api/admin/content/reset` : recreer le brouillon depuis le contenu par defaut ou publie. Non implementee.
- `POST /api/admin/media` : uploader un media. Non implementee.
- `DELETE /api/admin/media/:id` : supprimer un media non reference. Non implementee.
- `POST /api/auth/login` : ouvrir une session. Non implementee.
- `POST /api/auth/logout` : fermer une session. Non implementee.
- `GET /api/auth/session` : verifier la session. Non implementee.

## Prochaine passe recommandee

La plus petite passe operationnelle consiste a deployer l'API Express sur un hebergeur avec volume persistant, configurer `CONTENT_API_URL` dans Vercel, puis valider le rendu production API/fallback.
