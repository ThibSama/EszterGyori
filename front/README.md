# Eszter Frontend

Application Next.js publique et prototype `/admin` local.

Le frontend depend du package partage local `@eszter/contracts`, situe dans `../contracts`. Toute construction doit donc utiliser le depot complet comme contexte, avec `front` comme repertoire racine.

> **Cible de deploiement.** Depuis le paquet 2.1 (ESZ-020) le frontend **est** un export statique (`output: "export"`) destine a l'hebergement mutualise Hetzner (`docs/hetzner-target-architecture.md`), avec un backend PHP same-origin sous `/api`. Aucun runtime Node ne subsiste en production : plus de middleware, plus de route handler, plus de dependance server-only. Le backend Express (`API/`) a ete retire au paquet 1.2 (ESZ-015) : le seul backend actif est `php/`. Voir `docs/static-frontend-and-injection.md`.

## Commandes

Depuis la racine du depot :

```powershell
npm --prefix front install
npm run dev
npm run build
```

La commande de developpement recommandee est `npm run dev` depuis `E:\Eszter`. Elle delegue au frontend et execute automatiquement `npm run build:contracts` avant le demarrage Next.js.

Depuis `front/` directement :

```powershell
npm install
npm run dev
npm run lint
npm run build
npm run verify:export
```

Il n'y a plus de `npm run start` : `next start` demarre un serveur Node, et l'hote cible
n'en a pas. `npm run build` produit `front/out/`, et `npm run verify:export` verifie que
cette sortie est deployable sans Node (aucune route dynamique, aucun middleware, aucune
dependance server-only, et les deux elements d'injection presents dans `out/index.html`).

`front/.npmrc` sets `install-links=true` so npm installs the local `file:../contracts` dependency as a package copy instead of a symlink. This keeps runtime dependencies such as `zod` resolvable during Next.js builds on Vercel and locally.

The frontend owns compilation of the shared package during install, development startup, and production build:

```powershell
npm run build:contracts
```

This script uses the frontend-local TypeScript binary from `front/node_modules`; no global TypeScript installation is required. `contracts` no longer builds through `prepare`, so standalone contracts work remains `cd E:\Eszter\contracts`, `npm install`, then `npm run build`.

## Contenu public

La page `/` est exportee statiquement. Elle ne fait **aucun** appel reseau au chargement
et ne depend plus de `CONTENT_API_URL`, qui a ete retiree : sur l'hote cible, PHP lit le
contenu publie sur disque et l'injecte dans le fichier exporte avant de l'envoyer
(`docs/hetzner-target-architecture.md` §5).

`next build` inscrit le contenu canonique dans deux elements :

```html
<style  id="__ESZTER_APPEARANCE__">:root{--site-...}</style>
<script id="__ESZTER_CONTENT__" type="application/json">{...}</script>
```

PHP remplace le contenu de ces deux elements, reperes par leur `id`. Le reste du fichier
est transmis tel quel : PHP n'affiche pas la page, il en reecrit deux zones connues.

Consequences pour le frontend :

- le HTML exporte contient deja la copie francaise reelle, donc le premier rendu et les
  moteurs de recherche voient du contenu, jamais une coquille vide ;
- `readPublicContentBootstrap()` relit la charge utile et la revalide avec
  `publishedContentEnvelopeV1Schema`. Element absent, JSON invalide, enveloppe non
  conforme : la page retombe sur `defaultSiteContent` et ne peut pas echouer ;
- l'ecart entre le HTML exporte (valeurs par defaut) et la charge utile injectee
  (contenu publie) est resolu par `useSyncExternalStore`, ce qui evite une erreur
  d'hydratation ;
- les couleurs ne clignotent pas : elles arrivent dans le `<style>` du `<head>`, donc
  avant l'execution de React. C'est pourquoi `SitePreview` accepte `appearanceSource` et
  que la page publique passe `"document"`.

La revalidation ISR de 60 secondes a disparu avec le serveur Node. Elle est remplacee
par `Cache-Control: public, max-age=0, must-revalidate` et l'ETag `"published-<revision>"`,
tous deux emis par PHP.

## Admin

`/admin` est un **shell statique**, et il n'applique aucun controle d'acces.

La connexion frontend server-side (middleware `proxy.ts`, routes `/admin/auth/*`,
verification scrypt, session JWT signee) a ete **supprimee, pas portee** : un hebergement
statique n'a pas de middleware, et un controle execute dans le navigateur, devant une
page que l'appelant possede deja, n'est pas un controle d'acces — c'est une decoration
qui rend la faille plus difficile a voir.

Le paquet 2.2 a place l'autorisation dans PHP, verifiee a chaque appel `/api/admin/*`
(`docs/hetzner-target-architecture.md` §6), et c'est toujours la seule autorite.

Le paquet 3.2 (ESZ-034/035) a branche le navigateur dessus :

- `/admin/login` est un vrai formulaire. Il lit `GET /api/auth/session` pour obtenir le
  jeton CSRF que la connexion elle-meme exige, poste vers `POST /api/auth/login`, et ne
  verifie rien lui-meme ;
- `/admin` appelle `GET /api/auth/session` au montage et ne rend l'editeur que pour un
  appelant que PHP declare authentifie. C'est un choix d'affichage, pas une securite : un
  401 sur n'importe quel appel reste la reponse qui fait autorite ;
- l'editeur charge `GET /api/admin/content/draft`, enregistre via `PUT` avec la revision
  recue comme `expectedRevision`, publie via `POST …/publish` et restaure le contenu
  publie via `POST …/reset` ;
- `php/public/.htaccess` contient un bloc Basic auth commente ; c'est un palliatif au
  niveau du serveur web, jamais la conception.

Cote contenu, `/admin` n'est plus local-only :

- edition en memoire, apercu identique au site public ;
- **brouillon serveur** faisant autorite, avec revision et `expectedRevision` sur chaque
  ecriture ;
- **resolution de conflit 409 par reconciliation a trois versions** (base / local /
  serveur) : sauvegarde locale, relecture du contenu serveur, fusion deterministe des
  seules modifications sans chevauchement, validation du resultat, puis une unique
  nouvelle tentative. Aucun ecrasement force, aucune boucle de reprise, et la revision
  n'avance jamais depuis un simple entete de reponse ;
- **publication explicite**, distincte de l'enregistrement ;
- `localStorage` conserve comme **sauvegarde de secours explicite** uniquement : jamais
  relue au chargement, jamais appliquee sans confirmation, mais ecrite automatiquement
  avant toute operation qui remplace le contenu affiche ;
- import/export JSON ;
- edition de l'apparence via une palette globale et une teinte controlee par section ;
- champs avec placeholders d'exemple uniquement, sans remplacer les labels ;
- apercu `Telephone`, `Tablette` et `Ordinateur` via une iframe protegee `/admin/preview` ;
- aucun secret de session dans le navigateur : le cookie de session est `__Host-` et
  illisible par le script, le jeton CSRF vit en memoire le temps de l'onglet.

`/admin/availability` (paquet 6.2, ESZ-063/064) edite les disponibilites :

- **horaires hebdomadaires** par jour ISO, plusieurs plages par jour, activation et bornes
  de validite facultatives. L'enregistrement envoie **la semaine complete dans une seule
  requete** `PUT /api/admin/availability/weekly` : c'est cette forme qui rend le
  remplacement atomique, puisqu'il n'y a qu'une requete a echouer et qu'un refus laisse
  l'horaire precedent en place ;
- **prevalidation navigateur** des chevauchements, des plages vides ou inversees et des
  periodes de validite incoherentes. Elle sert uniquement a designer la ligne fautive a
  cote de la ligne fautive : le serveur revalide tout et fait seule autorite ;
- **exceptions de date** via `PATCH /api/admin/availability/exceptions` (`close`, `open`,
  `remove`). Une exception **remplace** les horaires hebdomadaires de la date, elle ne s'y
  ajoute jamais ; supprimer l'exception restaure le comportement hebdomadaire et
  n'annule aucun rendez-vous. Les fermetures et les suppressions sont confirmees
  explicitement ;
- apres chaque succes, l'editeur affiche **l'etat renvoye par le serveur** (identifiants,
  ordre, normalisations comprises) et jamais ce qu'il vient d'envoyer.

`/admin/bookings` porte en plus un **resume operationnel** (ESZ-065) : rendez-vous
confirmes du jour et des sept prochains jours, prochain rendez-vous, et compteurs. Les
rendez-vous annules sont comptes a part et n'apparaissent jamais dans un compteur actif
ni dans une liste ; le partage entre confirme et annule est fait par le serveur.

Ce qui n'est toujours pas la : les notifications et la limitation des tentatives de
connexion. Le parcours public de reservation couvre maintenant selection, coordonnees,
verification, soumission et confirmation sans stockage navigateur des donnees cliente.

L'apercu admin recoit seulement du `SiteContent` valide par `postMessage` same-origin. Le contenu d'apercu n'est pas persiste. Les dimensions logiques sont fixes a 390 x 844 pour `Telephone`, 768 x 1024 pour `Tablette` et 1440 x 900 pour `Ordinateur`. Le panneau mesure l'espace disponible avec `ResizeObserver`, puis applique `scale = min(availableWidth / deviceWidth, availableHeight / deviceHeight, 1)` au viewport complet afin de conserver les vrais breakpoints dans l'iframe. Les animations reveal y sont desactivees pour que toutes les sections restent visibles dans les captures, tandis que le site public conserve ses animations normales et respecte `prefers-reduced-motion`.

Les anciennes sauvegardes locales valides restent lisibles telles quelles, meme si elles contiennent d'anciens textes, et ne sont jamais reecrites silencieusement. Elles ne sont plus chargees automatiquement : il faut demander `Restaurer la sauvegarde locale`, puis enregistrer pour que le serveur en tienne compte.

L'apparence est stockee dans `SiteContent.appearance`. Les anciennes sauvegardes sans `appearance` sont acceptees et normalisees en memoire vers `defaultSiteAppearance` ; elles ne sont pas reecrites sur l'appareil avant une sauvegarde ou un export explicite. Les exports JSON actuels contiennent toujours `appearance`.

Les controles couleur utilisent uniquement des champs natifs `input type="color"` et des valeurs hexadecimales `#RRGGBB` validees par le contrat. Les teintes de section sont appliquees avec une intensite fixe et legere pour conserver la lisibilite. Le contraste est valide avant sauvegarde/export, et les boutons remplis calculent automatiquement un texte blanc ou sombre.

L'admin propose depuis le paquet 3.2 la publication et le brouillon serveur. Il ne propose toujours pas d'upload media. Le site public ne contient toujours aucun lien vers `/admin`.

Aucune autorisation n'existe cote frontend, et c'est volontaire. Toute future route PHP
de mutation devra verifier sa propre session et sa propre autorisation : la session du
frontend ne doit jamais en tenir lieu. Le backend PHP n'expose aujourd'hui que
`GET /api/health`, `GET /api/content` et `GET|HEAD /`, tous publics et read-only.

## Vercel (historique)

La preview Vercel decrivait un deploiement avec runtime Node et les variables
`CONTENT_API_URL` et `ADMIN_*`. Aucune de ces variables n'existe plus, et le frontend ne
peut plus rendre de page cote serveur : la section a ete retiree plutot que conservee,
parce qu'elle documentait une configuration qui ne peut plus fonctionner.

Ce qui reste vrai et utile : `front/.npmrc` fixe `install-links=true`, donc npm installe
`file:../contracts` comme une **copie** et non comme un lien symbolique. Une modification
de `contracts/` n'est donc visible par `front/` qu'apres reinstallation (`npm ci` dans
`front/`), ce qui surprend au premier passage.

## Backend

Le frontend n'est pas dockerise. L'image Docker qui existait ne concernait que le
service Express `API/`, retire au paquet 1.2 (ESZ-015) avec son `Dockerfile` ; il n'y a
plus d'image dans ce depot.

Le backend est `php/`, en same-origin sous `/api` sur l'hote final. Depuis ESZ-021 il
sert egalement `/` : le frontend n'a donc plus besoin de connaitre une URL d'API, et
`CONTENT_API_URL` a ete supprimee. Il n'y a plus de configuration cross-origin a prevoir,
donc plus de CORS, plus de preflight, plus de cookie cross-site.

Ouvert directement depuis le systeme de fichiers ou servi par un hebergeur statique sans
PHP, `front/out/index.html` reste une page valide : elle affiche le contenu canonique.
C'est le repli, pas le mode de fonctionnement.
