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

La route `/admin` existe et fournit un editeur frontend local protege par `/admin/login`.

L'editeur :

- exige une session frontend valide avant de rendre `ContentEditor` ;
- initialise son etat depuis une copie de `defaultSiteContent` ;
- permet de modifier les textes, URLs editables, sources medias et textes alternatifs ;
- affiche un apercu via le meme `SitePreview` que le site public ;
- conserve l'ordre, le nombre d'items, les IDs techniques et la structure des sections ;
- n'appelle pas `GET /api/content`.

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

La session admin est stockee dans un cookie `eszter_admin_session` `HttpOnly`, `SameSite=Strict`, `path=/admin`. Les sessions sont stateless : supprimer le cookie deconnecte le navigateur courant, mais un token deja emis ne peut pas etre revoque individuellement avant expiration sans etat serveur.

## Brouillon local et JSON

Le brouillon local utilise `localStorage` sous la cle :

```text
eszter:admin-content-draft:v1
```

L'admin permet :

- l'enregistrement explicite du brouillon local ;
- la restauration au rechargement de `/admin` ;
- la suppression du brouillon local ;
- l'export JSON versionne ;
- l'import JSON avec validation runtime ;
- la reinitialisation complete vers `defaultSiteContent`.

Ces operations restent locales au navigateur et ne publient pas le site public.

La reinitialisation complete supprime d'abord le brouillon `localStorage` du navigateur courant, puis remplace le contenu editeur, l'apparence et l'etat propre par le contenu canonique. Elle ne supprime pas le cookie d'authentification, les exports JSON, ni le contenu serveur (`php/data/content/draft.json`, `php/data/content/published.json`).

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

Les ecritures restent atomiques : fichier temporaire, `fflush`, `fsync`, `chmod 0640`,
`rename()` sur le meme systeme de fichiers. Un document requis malforme, trop gros ou
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

Le projet ne contient pas encore :

- endpoint de brouillon serveur ;
- endpoint d'ecriture de brouillon ;
- publication ;
- integration API admin ;
- authentification backend ;
- cookies ou sessions serveur ;
- base de donnees ;
- routes HTTP d'ecriture de ce stockage ;
- stockage serveur d'images ;
- upload reel ;
- CSS arbitraire, edition de polices, edition d'espacement ou edition de layout ;
- reverse proxy ;
- HTTPS ;
- sauvegarde automatisee ;
- monitoring.
