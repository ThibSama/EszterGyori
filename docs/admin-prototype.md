# Prototype d'administration frontend

La route `/admin` fournit un editeur de contenu cote frontend pour le site vitrine Eszter. Elle utilise le contrat partage `SiteContent`, sans publication et sans stockage serveur.

> **Obsolete depuis le paquet 2.1 (ESZ-020) : la section « Authentification frontend » ci-dessous decrit un mecanisme supprime.** Le frontend est un export statique ; le middleware `proxy.ts`, les routes `/admin/auth/*` et tout `front/app/lib/auth/` ont ete supprimes, ainsi que les variables `ADMIN_*`. **`/admin` n'est plus protege.** Un hebergement statique ne peut pas executer ce controle, et le reproduire dans le navigateur ne serait pas un controle d'acces. Le paquet 2.2 place l'autorisation dans PHP, verifiee a chaque appel `/api/admin/*`. Voir `docs/static-frontend-and-injection.md` §3 et `docs/hetzner-target-architecture.md` §6.
>
> Tout ce qui concerne l'**editeur** lui-meme (brouillon `localStorage`, import/export, apparence, apercu) reste exact.

Le backend PHP (`php/`) expose `GET /api/health`, `GET /api/content` et `GET | HEAD /`, mais `/admin` ne les appelle pas. Le service Express historique (`API/`) a ete retire au paquet 1.2 (ESZ-015).

## Authentification frontend

`/admin/login` verifie un compte administrateur unique configure par variables server-only :

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `ADMIN_SESSION_TTL_SECONDS`

Le mot de passe est verifie avec un hash `scrypt-v1`. Une connexion valide cree un cookie `eszter_admin_session` signe, `HttpOnly`, `SameSite=Strict`, limite au chemin `/admin`.

L'en-tete protege affiche `Administration Eszter`, `Retour au site` et `Se deconnecter`. `Retour au site` est un lien Next.js normal vers `/` dans le meme onglet ; il preserve la session. La deconnexion reste un formulaire `POST /admin/auth/logout` et supprime le cookie de session.

Si la configuration est absente ou invalide, le build continue de fonctionner, le site public reste disponible, mais la connexion admin echoue fermee.

Cette barriere protege seulement l'interface Next.js. Elle n'autorise aucune route backend et ne doit pas etre consideree suffisante pour de futures mutations serveur.

## Contrat partage

Le contrat runtime et le contenu par defaut canonique sont definis hors de `front/app/`, dans le package partage racine `contracts/`, expose sous le nom `@eszter/contracts`.

- `contracts/site-content.ts` definit le schema strict `siteContentSchema`.
- `contracts/content-envelopes.ts` definit les enveloppes versionnees.
- `contracts/default-site-content.ts` definit `defaultSiteContent`.
- `front/app/types/site-content.ts` re-exporte les types inferes pour conserver les imports frontend existants.

## Rendu public et admin

La homepage publique est exportee statiquement : PHP injecte le contenu publie dans le HTML exporte au moment de la requete, avec repli sur `defaultSiteContent`. `CONTENT_API_URL` n'existe plus.

`/admin` reste local-only :

- la homepage publique passe le contenu charge cote serveur a `SitePreview` ;
- `/admin` passe l'etat edite en memoire ;
- `/admin/preview` est une route protegee utilisee comme iframe same-origin pour obtenir de vrais breakpoints responsives ;
- les changements admin ne modifient jamais `/` ;
- aucun appel API n'est effectue depuis l'admin.

`SiteContent.appearance` permet maintenant d'editer l'identite visuelle locale. L'interface expose une palette globale (`Fond general`, `Surface des cartes`, `Texte principal`, `Texte secondaire`, `Couleur principale`, `Couleur secondaire`, `Accent chaud`) et une teinte legere par section (`Navigation`, `Hero`, `Reassurance`, `Prestations`, `Parcours`, `Realisations`, `A propos`, `Contact`, `Pied de page`).

Les controles utilisent uniquement `input type="color"` et affichent la valeur hexadecimale normalisee. Les couleurs sont validees par le contrat `#RRGGBB`; les valeurs CSS arbitraires, gradients, variables, alpha, polices et espacements ne sont pas editables.

Les teintes de section sont melangees avec le fond a intensite fixe, environ 12 a 25 %, afin de rester subtiles. Le contraste global est valide, et les boutons remplis calculent automatiquement un texte blanc ou sombre.

L'iframe d'apercu initialise `defaultSiteContent`, puis accepte uniquement les messages `ESZTER_ADMIN_PREVIEW_CONTENT` venant de la meme origine et de `window.parent`. Le payload contient seulement du `SiteContent` valide par `siteContentSchema`, sans cookie, token ni secret. Le contenu d'apercu n'est pas persiste.

L'editeur propose deux modes d'apercu locaux non persistants : `Telephone` autour de 390 px et `Ordinateur` autour de 1280 px. Le cadre est redimensionne visuellement avec `ResizeObserver` sans changer la largeur reelle de l'iframe.

Les animations reveal-on-scroll restent actives sur le site public. Dans l'apercu admin, elles sont desactivees pour que toutes les sections soient visibles immediatement, y compris dans les captures pleine page. `prefers-reduced-motion` continue aussi d'afficher le contenu immediatement.

## Etat local

L'editeur initialise son etat avec une copie independante de `defaultSiteContent` via `structuredClone`, puis verifie cote client si un brouillon local existe.

Le stockage local utilise uniquement cette cle :

```text
eszter:admin-content-draft:v1
```

Le brouillon local est specifique au navigateur courant. Il n'est pas disponible sur un autre appareil, n'est pas envoye a un serveur et ne publie pas le site public.

Les anciens brouillons locaux valides ne sont pas reecrits ni supprimes silencieusement au chargement. Ils continuent d'etre charges tels quels. L'action `Reinitialisation complete` supprime le brouillon local du navigateur puis restaure l'integralite du contenu canonique `defaultSiteContent`. Si la suppression locale echoue, l'interface affiche l'erreur sure existante et ne declare pas le reset reussi.

Les anciens brouillons sans `appearance` sont acceptes et recoivent `defaultSiteAppearance` en memoire. Ils ne sont reecrits qu'apres `Enregistrer le brouillon local` ou `Exporter le brouillon JSON`.

## Import et export

La sauvegarde locale est explicite via `Enregistrer le brouillon local`. Elle valide le contenu courant, cree une enveloppe `schemaVersion: 1`, ecrit le JSON dans `localStorage` et marque l'etat comme propre.

`Exporter le brouillon JSON` telecharge le contenu actuellement visible, y compris les modifications non enregistrees. `Importer un JSON` lit un fichier local `.json` de 1 Mo maximum, le valide, demande confirmation et remplace seulement l'etat editeur.

Les champs reutilisables `Field` et `TextArea` acceptent des placeholders courts d'exemple. Les labels restent toujours visibles ; les placeholders n'ont aucun role de validation et ne remplacent pas le contenu courant.

## Elements fixes

Cette passe ne permet pas de modifier :

- l'ordre des sections ;
- le nombre de sections ;
- le nombre d'items repetes ;
- les IDs techniques ;
- les styles, couleurs, espacements, animations et breakpoints ;
- les comportements techniques de navigation interne.

L'edition d'apparence reste volontairement limitee : pas de CSS arbitraire, pas de gradients saisis, pas d'alpha, pas de polices, pas d'espacements, pas de layout et pas de publication.

## Securite et futur backend

La route `/admin` a maintenant une protection frontend, mais l'API PHP n'a pas d'authentification ni d'autorisation admin : elle n'expose que deux routes publiques read-only. Le backend devra verifier sa propre session avant toute route de brouillon, publication ou upload, et ces routes devront entrer dans `contracts/http-contract.ts` avant d'etre implementees.

`GET /api/content` est public et read-only. Il lit uniquement `published.json`, retourne `PublishedContentEnvelopeV1`, supporte les ETags, et n'expose pas le brouillon.
