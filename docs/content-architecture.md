# Architecture de contenu actuelle

Ce document decrit l'etat actuel du depot Eszter.

> **Mis a jour par le paquet 2.1 (ESZ-020/021/022).** Le frontend est un export statique
> et `CONTENT_API_URL` a ete supprimee : PHP sert `/` et injecte le contenu publie dans
> le HTML exporte. La session admin frontend a ete supprimee et `/admin` n'est plus
> protege — le paquet 2.2 place l'autorisation dans PHP. Les passages ci-dessous qui
> mentionnent `CONTENT_API_URL` ou `/admin/auth/*` sont annotes.
> Voir `docs/static-frontend-and-injection.md`.

## Applications

- `front/` contient l'application Next.js publique et l'admin frontend local.
- `php/` contient le backend PHP, seule implementation active de la surface publique.
- `contracts/` contient le package prive partage `@eszter/contracts`.

Le backend PHP expose `GET /api/health`, `GET /api/content` et, depuis ESZ-021, `GET | HEAD /`.

Le service Express historique (`API/`) a ete retire au paquet 1.2 (ESZ-015). Il n'existe plus dans le depot ; les documents qui le decrivent sont historiques et signales comme tels. Voir `docs/contract-freeze.md`, partie 5.

La homepage publique est servie par PHP, qui injecte l'enveloppe publiee dans le HTML exporte (ESZ-021). Elle ne fait aucun appel reseau au chargement. `/admin` ne consomme pas l'API.

`/admin` est protege par une session frontend signee. Cette protection ne s'applique pas encore aux endpoints PHP.

Le site public ne contient pas de lien vers `/admin`. Depuis l'interface d'administration, `Retour au site` navigue vers `/` dans le meme onglet. Il n'y a plus de bouton de deconnexion : la session frontend a ete supprimee avec le runtime Node (ESZ-020), et `/admin` n'est pas protege en attendant le paquet 2.2.

## Contrat partage

Le contrat de contenu runtime est defini dans le package partage racine `contracts/`.

- `contracts/site-content.ts` contient les schemas Zod stricts du contenu du site.
- `contracts/content-envelopes.ts` contient les enveloppes versionnees.
- `contracts/default-site-content.ts` contient la valeur canonique `defaultSiteContent`.
- `contracts/appearance.ts` contient `SiteContent.appearance`, `defaultSiteAppearance`, la validation hexadecimale, le contraste et les utilitaires couleur.
- `contracts/http-contract.ts` contient le contrat HTTP gele de la surface publique.
- `contracts/semantic-rules.ts` contient les regles de validation que JSON Schema ne peut pas exprimer, avec leur corpus de parite.
- `contracts/parity-runtime.ts` contient l'implementation de reference du lecteur de corpus.
- `contracts/generated/` contient les artefacts neutres en langage (JSON Schema, regles semantiques, corpus de parite, contrat HTTP, manifeste). Ce repertoire est genere puis commite ; ne jamais l'editer a la main.
- `contracts/index.ts` re-exporte les schemas, constantes et types.
- `contracts/package.json` expose ces exports sous le nom `@eszter/contracts`.

`front/app/content/default-site-content.ts` reste un fichier de compatibilite qui re-exporte la valeur par defaut pour le frontend.

`front/` est le seul consommateur Node de `@eszter/contracts`, declare via une dependance locale `file:../contracts`. Le backend PHP ne consomme pas le package npm : il lit les artefacts JSON commites dans `contracts/generated/`, verifies par empreinte SHA-256 au chargement. Aucun Node n'est requis a l'execution du backend.

Regenerer `contracts/generated/` avec `npm run generate` dans `contracts/` apres toute modification de schema. `npm test` echoue si les artefacts commites divergent des sources Zod. Les sources de premier niveau ne doivent jamais importer depuis `generated/` : ce sont les *entrees* du generateur, donc importer sa sortie ferait dependre la regeneration de la generation precedente. Jusqu'a ESZ-015 la regle etait aussi appliquee mecaniquement, parce que `API/Dockerfile` ne copiait que `contracts/*.ts` ; l'image a disparu, la regle non.

Le detail est documente dans `docs/contract-freeze.md`.

## Rendu public

`front/app/page.tsx` charge le contenu public avec `front/app/lib/server/public-content.ts`.

La page lit l'enveloppe injectee par PHP dans `<script id="__ESZTER_CONTENT__">`, la valide avec `publishedContentEnvelopeV1Schema`, puis rend `envelope.content`. Toute anomalie (element absent, JSON invalide, enveloppe non conforme) retombe sur `defaultSiteContent`.

Si la variable est absente, invalide, si l'API echoue, ou si la reponse ne valide pas le schema, la page rend `defaultSiteContent`.

La revalidation Next.js est de 60 secondes. L'URL API reste server-only et n'est pas exposee au navigateur.

Le rendu final passe toujours seulement le contenu a la presentation :

```tsx
<SitePreview content={content} />
```

Le site public ne lit pas `localStorage` et ne consomme pas de brouillon admin.

## Administration frontend

> Section corrigee au paquet 3.2 (ESZ-034/035). Elle decrivait un editeur purement
> local, une protection assuree par le frontend et un cookie de session signe par
> Next. Les trois affirmations sont fausses depuis les paquets 2.2 et 3.2.

La route `/admin` est un fichier statique. Elle **n'applique aucun controle d'acces** et
ne peut pas en appliquer : le controle et la ressource protegee s'executeraient tous
deux dans le navigateur de l'appelant. L'autorite est PHP, par requete, sur chaque appel
`/api/admin/*` (`auth.accessControl`).

Ce que fait le shell est plus etroit : au montage, il appelle
`GET /api/auth/session` et ne rend l'editeur que pour un appelant que PHP declare
authentifie. C'est une decision d'affichage — elle evite de presenter des boutons qui
repondraient tous 401 — et non une securite.

L'editeur :

- charge le brouillon serveur (`GET /api/admin/content/draft`) avant d'afficher un seul
  champ, et affiche un ecran d'attente ou d'indisponibilite tant qu'il n'en a pas ;
- enregistre via `PUT /api/admin/content/draft` en envoyant la revision qui lui a ete
  remise comme `expectedRevision`, avec le jeton CSRF dans `X-CSRF-Token` ;
- publie via `POST /api/admin/content/publish` et restaure le contenu publie via
  `POST /api/admin/content/reset` (`source: "published"`), sans jamais reimplementer ces
  operations cote navigateur ;
- distingue trois etats : modifications non enregistrees, brouillon enregistre non
  publie, publie ;
- permet de modifier les textes, URLs editables, sources medias et textes alternatifs ;
- affiche un apercu via le meme `SitePreview` que le site public, alimente par le
  contenu en cours d'edition : l'apercu montre donc les modifications non enregistrees,
  et ne publie rien ;
- conserve l'ordre, le nombre d'items, les IDs techniques et la structure des sections ;
- appelle `GET /api/content` en lecture seule, uniquement pour connaitre la revision
  publiee affichee dans l'entete d'etat.

### Conflits de revision

`PUT`, `publish` et `reset` portent tous `expectedRevision`. Si le brouillon a bouge, PHP
repond `409 REVISION_CONFLICT` sans rien ecrire, et transporte la tete courante dans
`X-Content-Revision`.

L'editeur ne rejoue jamais la requete automatiquement, et ne force jamais une ecriture.
Sur un 409 a l'enregistrement il execute une **reconciliation a trois versions** :

1. il ecrit une sauvegarde locale du brouillon de travail — a cet instant le contenu
   affiche est la seule copie existante ;
2. il relit le brouillon serveur courant, c'est-a-dire son **contenu**, pas seulement sa
   tete ;
3. il compare de maniere deterministe la base (le contenu de la revision chargee au
   depart), la version locale et la version serveur ;
4. il fusionne uniquement les modifications qui ne se chevauchent pas ;
5. tout chevauchement — meme champ modifie des deux cotes, structure divergente, liste
   reordonnee, ajoutee ou tronquee — est un conflit explicite, jamais devine ;
6. il valide le document fusionne contre `SiteContent` avant toute ecriture ;
7. si la fusion est propre, il adopte la revision de l'enveloppe relue et rejoue
   l'enregistrement **une seule fois** ;
8. sinon il n'ecrit rien, affiche la liste des elements en conflit et laisse le contenu
   affiche intact, la sauvegarde locale restant disponible.

Un second 409 pendant cette unique nouvelle tentative n'est pas rejoue : il est signale,
et une nouvelle action explicite est requise. Il n'existe aucune boucle de reprise.

Les listes sont traitees de facon conservatrice. Les collections de `SiteContent` sont de
longueur fixe et indexees par `id` ; une longueur differente ou un ordre different n'est
donc pas une modification editoriale ordinaire mais un changement structurel, et fusionner
element par element apparierait des elements qui n'en sont pas. Ces cas sont refuses.

La revision detenue par l'editeur n'avance que lorsque le serveur renvoie une enveloppe,
c'est-a-dire une revision **accompagnee du contenu correspondant**. La tete annoncee dans
`X-Content-Revision` sur un 409 est affichee a titre indicatif et n'est jamais adoptee :
ecrire contre un numero dont le document n'a pas ete lu est exactement l'ecrasement que le
409 empeche. Un editeur perime reste donc perime tant que la reconciliation n'a pas
abouti, et sa prochaine ecriture est refusee sous verrou plutot que d'ecraser un contenu
plus recent.

Pour `publish` et `reset`, il n'y a rien a fusionner : ces operations portent sur ce qui
est **stocke**. Un 409 y declenche une relecture de l'etat serveur, puis l'editeur
s'arrete et attend une nouvelle action explicite. Rien n'est publie ni restaure
automatiquement. Si l'editeur contient des modifications non enregistrees, le contenu relu
n'est pas applique : la revision reste perimee et la reconciliation reste l'issue
proposee.

Une session expiree (401) bascule toute la zone admin sur l'ecran de connexion. Un jeton
CSRF perime (403) ne deconnecte pas : la session est relue pour en obtenir un neuf.

L'editeur expose des placeholders courts d'exemple dans les champs texte, URL, email et textarea. Ils ne remplacent pas les labels, ne sont pas persistes et ne changent pas la validation.

L'editeur expose aussi une carte `Apparence` avant `Navigation`. Elle modifie seulement `SiteContent.appearance` :

- palette globale : fond, surface, texte principal, texte secondaire, couleur principale, couleur secondaire, accent chaud ;
- teintes de sections : navigation, hero, reassurance, prestations, parcours, realisations, a propos, contact, pied de page.

Les teintes de section sont appliquees avec une intensite fixe et subtile. Les couleurs acceptent seulement `#RRGGBB`, sont normalisees en majuscules, et les palettes a contraste insuffisant sont rejetees. Les foregrounds des boutons sont calcules automatiquement et ne sont pas stockes.

L'apercu admin propose deux modes locaux non persistants :

- `Telephone`, avec une largeur reelle d'iframe de 390 px ;
- `Ordinateur`, avec une largeur reelle d'iframe de 1280 px.

La route protegee `/admin/preview` est chargee dans une iframe same-origin. Le parent envoie uniquement un payload `ESZTER_ADMIN_PREVIEW_CONTENT` contenant du `SiteContent` valide. L'iframe verifie l'origine, `event.source === window.parent`, le type du message et `siteContentSchema`. Aucun token, cookie ou secret n'est envoye dans le message, et le contenu d'apercu n'est jamais stocke.

Les reveal-on-scroll sont desactives uniquement dans l'apercu admin afin que les sections ne restent pas invisibles dans les captures ou dans le cadre contraint. Le site public conserve les animations normales et les utilisateurs en `prefers-reduced-motion` voient le contenu immediatement.

La session admin est un identifiant opaque dans le cookie `__Host-eszter_session`
(`HttpOnly`, `Secure`, `SameSite=Strict`, `path=/`), adosse a un enregistrement serveur
dans `admin_sessions` (ESZ-025). Le navigateur ne peut pas lire ce cookie. Le jeton CSRF
vit en memoire pour la duree de l'onglet : il n'est ecrit ni dans `localStorage`, ni dans
une URL, ni dans un journal.

## Sauvegarde locale et JSON

> Section corrigee au paquet 3.2. `localStorage` n'est plus la source de verite.

Le brouillon serveur fait foi. `localStorage` conserve un seul role — **sauvegarde
explicite de secours** — sous la cle :

```text
eszter:admin-content-draft:v1
```

L'admin permet :

- l'ecriture explicite d'une sauvegarde locale ;
- sa restauration explicite dans l'editeur, qui n'atteint le serveur qu'apres un
  enregistrement ;
- sa suppression ;
- l'export JSON versionne ;
- l'import JSON avec validation runtime ;
- la restauration du contenu publie, qui passe par le serveur.

Ce qui a disparu : la restauration automatique au chargement de `/admin`. Une sauvegarde
locale n'est jamais appliquee sans action de l'admin, et n'ecrase donc jamais l'etat
serveur d'elle-meme. Elle est en revanche ecrite automatiquement avant toute operation
qui va remplacer le contenu affiche — conflit 409, rechargement du brouillon serveur,
restauration du contenu publie sur un editeur modifie — afin qu'un travail non
enregistre ait toujours une copie.

La sauvegarde locale ne contient que `schemaVersion`, `savedAt` et `content`. Aucun
identifiant de session ni jeton n'y figure.

Les anciens brouillons locaux valides continuent d'etre charges sans reecriture silencieuse. Un ancien brouillon sans `appearance` recoit `defaultSiteAppearance` en memoire et inclura `appearance` seulement lors d'une sauvegarde ou export explicite.

## Backend PHP actuel

Le package `php/` :

- ne consomme aucun runtime Node ; il lit `contracts/generated/*.json` comme donnees ;
- verifie l'empreinte SHA-256 de chaque artefact au demarrage, et refuse de demarrer si une regle semantique declaree n'est pas implementee ;
- expose `GET /api/health` : ne lit aucun fichier, ne prend aucun verrou, n'interroge pas le stockage. Le corps gele est `status`, `service`, `contentSchemaVersion`, `timestamp`. Il n'y a plus de `uptimeSeconds` (retire du contrat au paquet 1.2 : chaque requete PHP est son propre processus, donc aucune duree de fonctionnement n'est mesurable honnetement) ;
- expose `GET /api/content`, public et read-only, qui retourne `PublishedContentEnvelopeV1` depuis `published.json` ;
- revalide l'enveloppe avant l'envoi : une reponse qui ne valide pas devient un 500 `STORAGE_FAILURE` opaque, jamais un contenu silencieusement degrade ;
- gere un ETag `"published-<revision>"` et `If-None-Match`. La `revision` est la seule entree du tag. Un 304 conserve `ETag` et `Cache-Control` et ne porte aucun corps, pas meme un objet JSON vide ;
- refuse un corps de requete au-dela de 64 kB avec 400 `INVALID_JSON`, avant le routage et quel que soit le `Content-Type` ;
- retourne l'enveloppe d'erreur JSON gelee, y compris quand c'est le demarrage lui-meme qui echoue (`bootstrapFailure`) : jamais une page d'erreur PHP en HTML.

### Stockage et verrouillage

Le stockage n'est plus initialise au demarrage. Seule la route qui en a besoin le
touche, ce qui garde `/api/health` independant du contenu (`health.doesNotDependOnContentStorage`)
et evite de rendre un 500 atteignable sur un chemin gele a 200/400/405.

Les lectures prennent un verrou **partage** (`LOCK_SH`). Le verrou exclusif est reserve
au semis et a l'ecriture, et le semis reverifie l'etat sous ce verrou. Le paquet 1.1
prenait le verrou exclusif inconditionnellement au demarrage, ce qui serialisait chaque
requete derriere une ecriture qui n'a presque jamais lieu.

Les ecritures restent atomiques : fichier temporaire ne a `0600` (le umask du
processus est restreint autour de sa creation puis retabli), `fflush`, `fsync`,
`chmod 0640` **verifie**, `rename()` sur le meme systeme de fichiers. Une
restriction de mode qui ne peut pas etre appliquee ou verifiee refuse la
publication : le fichier precedent reste byte-identique et le temporaire est
supprime. Un document requis malforme, trop gros ou
invalide interrompt le traitement ; il n'est jamais repare, remplace ni contourne.

### Conformite

Cette surface est gelee. `php/tests/Http/HttpContractConformanceTest.php` rejoue les 26
cas de `contracts/generated/http-contract.json` contre le `Kernel` reel : methodes,
statuts, 404/405, enveloppe d'erreur, IDs de requete, ETag/`If-None-Match`, 304,
en-tetes de cache, corps hors limite, echec de demarrage et echecs de stockage. Les
valeurs non deterministes (`timestamp`, IDs generes) sont verifiees par matcher, jamais
par valeur golden. Un seul cas est exempte pour PHP (`unknown.get.rootNotFound`), et
l'exemption est declaree dans l'artefact, pas dans un test ignore.

Le service Express rejouait le meme artefact jusqu'au paquet 1.2. Il a ete retire une
fois PHP vert sur tous les cas.

## Deploiement

La cible de deploiement est l'hebergement mutualise Hetzner decrite dans
`docs/hetzner-target-architecture.md` : export statique du frontend, backend PHP
same-origin sous `/api`, un seul fichier PHP joignable depuis la racine web
(`public_html/api/index.php`).

L'ancienne cible — image Docker pour `API/` plus frontend sur Vercel — est **abandonnee**.
Le `Dockerfile` et le `.dockerignore` ont ete supprimes avec le service Express.
`docs/backend-target-architecture.md` la decrit encore et est conserve comme document
historique.

Aucun hebergeur, reverse proxy, HTTPS, sauvegarde automatisee ni monitoring n'est
configure dans ce depot.

## Fonctionnalites non encore presentes

> Liste corrigee au paquet 3.1, puis au paquet 3.2. Elle affirmait encore l'absence de
> l'authentification backend, des sessions serveur et de la base de donnees, livrees au
> paquet 2.2 ; celle du brouillon serveur et de la publication, livres au paquet 3.1 ; et
> celle de l'integration API admin cote navigateur, livree au paquet 3.2.

Le projet ne contient pas encore :

- limitation du nombre de tentatives de connexion ;
- stockage serveur d'images ;
- upload reel ;
- CSS arbitraire, edition de polices, edition d'espacement ou edition de layout ;
- reverse proxy ;
- HTTPS ;
- sauvegarde automatisee ;
- monitoring.
