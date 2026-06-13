# Prototype d'administration frontend

La route `/admin` fournit un editeur de contenu cote frontend pour le site vitrine Eszter. Elle utilise le contrat partage `SiteContent` sans authentification, sans publication et sans stockage serveur.

Le service Express existe dans `API/` et expose `GET /api/health` et `GET /api/content`, mais `/admin` ne l'appelle pas.

## Contrat partage

Le contrat runtime et le contenu par defaut canonique sont definis hors de `front/app/`, dans le package partage racine `contracts/`, expose sous le nom `@eszter/contracts`.

- `contracts/site-content.ts` definit le schema strict `siteContentSchema`.
- `contracts/content-envelopes.ts` definit les enveloppes versionnees.
- `contracts/default-site-content.ts` definit `defaultSiteContent`.
- `front/app/types/site-content.ts` re-exporte les types inferes pour conserver les imports frontend existants.

## Rendu public et admin

La homepage publique peut consommer `GET /api/content` cote serveur via `CONTENT_API_URL`, avec fallback vers `defaultSiteContent`.

`/admin` reste local-only :

- la homepage publique passe le contenu charge cote serveur a `SitePreview` ;
- `/admin` passe l'etat edite en memoire ;
- les changements admin ne modifient jamais `/` ;
- aucun appel API n'est effectue depuis l'admin.

## Etat local

L'editeur initialise son etat avec une copie independante de `defaultSiteContent` via `structuredClone`, puis verifie cote client si un brouillon local existe.

Le stockage local utilise uniquement cette cle :

```text
eszter:admin-content-draft:v1
```

Le brouillon local est specifique au navigateur courant. Il n'est pas disponible sur un autre appareil, n'est pas envoye a un serveur et ne publie pas le site public.

## Import et export

La sauvegarde locale est explicite via `Enregistrer le brouillon local`. Elle valide le contenu courant, cree une enveloppe `schemaVersion: 1`, ecrit le JSON dans `localStorage` et marque l'etat comme propre.

`Exporter le brouillon JSON` telecharge le contenu actuellement visible, y compris les modifications non enregistrees. `Importer un JSON` lit un fichier local `.json` de 1 Mo maximum, le valide, demande confirmation et remplace seulement l'etat editeur.

## Elements fixes

Cette passe ne permet pas de modifier :

- l'ordre des sections ;
- le nombre de sections ;
- le nombre d'items repetes ;
- les IDs techniques ;
- les styles, couleurs, espacements, animations et breakpoints ;
- les comportements techniques de navigation interne.

## Securite et futur backend

La route `/admin` n'a pas encore d'authentification ni d'autorisation. Elle sert a valider le contrat et l'ergonomie avant l'integration backend.

`GET /api/content` est public et read-only. Il lit uniquement `published.json`, retourne `PublishedContentEnvelopeV1`, supporte les ETags, et n'expose pas le brouillon.
