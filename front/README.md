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

`/admin` est protege par une connexion frontend server-side :

- page publique `/admin/login` ;
- identifiant unique via `ADMIN_USERNAME` ;
- verification du mot de passe avec `ADMIN_PASSWORD_HASH` au format `scrypt-v1` ;
- session signee stateless via `ADMIN_SESSION_SECRET` ;
- cookie `eszter_admin_session` `HttpOnly`, `SameSite=Strict`, `path=/admin` ;
- expiration par defaut de 8 heures via `ADMIN_SESSION_TTL_SECONDS=28800` ;
- `Retour au site` dans l'en-tete admin renvoie vers `/` dans le meme onglet et conserve la session ;
- deconnexion par `POST /admin/auth/logout`, qui supprime le cookie de session.

Pour generer le hash du mot de passe :

```powershell
cd E:\Eszter\front
npm run auth:hash-password
```

Pour generer un secret de session :

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`/admin` reste local-only cote contenu :

- edition en memoire ;
- brouillon `localStorage` ;
- import/export JSON ;
- edition de l'apparence via une palette globale et une teinte controlee par section ;
- reinitialisation complete qui supprime le brouillon local du navigateur et restaure `defaultSiteContent`, y compris l'apparence canonique ;
- champs avec placeholders d'exemple uniquement, sans remplacer les labels ;
- apercu `Telephone` et `Ordinateur` via une iframe protegee `/admin/preview` ;
- aucun appel API ;
- aucune ecriture Express.

L'apercu admin recoit seulement du `SiteContent` valide par `postMessage` same-origin. Le contenu d'apercu n'est pas persiste. Les animations reveal y sont desactivees pour que toutes les sections restent visibles dans les captures, tandis que le site public conserve ses animations normales et respecte `prefers-reduced-motion`.

Les anciens brouillons locaux valides continuent d'etre charges tels quels, meme s'ils contiennent d'anciens textes. Ils ne sont pas reecrits silencieusement. L'utilisateur peut choisir `Reinitialisation complete` pour les supprimer et revenir au contenu canonique corrige.

L'apparence est stockee dans `SiteContent.appearance`. Les anciennes sauvegardes sans `appearance` sont acceptees et normalisees en memoire vers `defaultSiteAppearance` ; elles ne sont pas reecrites dans `localStorage` avant une sauvegarde ou un export explicite. Les exports JSON actuels contiennent toujours `appearance`.

Les controles couleur utilisent uniquement des champs natifs `input type="color"` et des valeurs hexadecimales `#RRGGBB` validees par le contrat. Les teintes de section sont appliquees avec une intensite fixe et legere pour conserver la lisibilite. Le contraste est valide avant sauvegarde/export, et les boutons remplis calculent automatiquement un texte blanc ou sombre.

L'admin ne propose toujours pas de publication, de routes de brouillon serveur, d'upload media ou d'integration API admin. Le site public ne contient toujours aucun lien vers `/admin`.

Cette protection empeche le chargement de l'editeur par des visiteurs non authentifies, mais elle ne remplace pas une future autorisation cote API. Toute future route Express de mutation devra verifier sa propre session/autorisation.

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
-> ADMIN_USERNAME
-> ADMIN_PASSWORD_HASH
-> ADMIN_SESSION_SECRET
-> ADMIN_SESSION_TTL_SECONDS
```

Tant que cette variable n'est pas configuree, la production continue de rendre `defaultSiteContent`.

## API Docker

Le frontend n'est pas dockerise dans cette passe. L'image Docker concerne uniquement `API/`.

Quand l'API sera deployee publiquement, Vercel devra conserver `front` comme Root Directory et recevoir la variable server-only :

```text
CONTENT_API_URL=https://<public-api-domain>/api/content
```

Sans cette variable, le frontend continue d'utiliser le fallback `defaultSiteContent`.
