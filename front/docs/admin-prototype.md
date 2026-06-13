# Prototype d'administration frontend

La route `/admin` fournit un éditeur de contenu côté frontend pour le site vitrine Eszter. Elle utilise le contrat partagé `SiteContent` sans authentification, sans publication et sans stockage serveur.

Un service Express minimal existe maintenant dans `server/`, mais `/admin` ne l'appelle pas. Le service expose uniquement `GET /api/health`.

## Contrat partagé

Le contrat runtime est défini hors de `app/`, dans `contracts/`, afin de pouvoir être réutilisé plus tard par le service Express sans dépendre de React, Next.js ou du navigateur.

- `contracts/site-content.ts` définit le schéma strict `siteContentSchema`.
- `contracts/content-envelopes.ts` définit les enveloppes versionnées.
- `app/types/site-content.ts` ré-exporte les types inférés pour conserver les imports frontend existants.

La dépendance de validation runtime est `zod`, déclarée directement dans `package.json`.

## Rendu et aperçu

Le site public et l'aperçu admin consomment le même composant `SitePreview`.

- La homepage publique passe toujours `defaultSiteContent`.
- `/admin` passe l'état édité en mémoire.
- Les changements admin ne modifient jamais `/`.
- Aucun appel API n'est effectué depuis l'admin dans l'état actuel.

## État local

L'éditeur initialise son état avec une copie indépendante de `defaultSiteContent` via `structuredClone`, puis vérifie côté client si un brouillon local existe.

Le stockage local utilise uniquement cette clé :

```text
eszter:admin-content-draft:v1
```

Le brouillon local est spécifique au navigateur courant. Il n'est pas disponible sur un autre appareil, n'est pas envoyé à un serveur et ne publie pas le site public.

## Format de brouillon

Les brouillons enregistrés et exportés utilisent l'enveloppe `SiteContentDraftV1` :

```ts
interface SiteContentDraftV1 {
  schemaVersion: 1;
  savedAt: string;
  content: SiteContent;
}
```

`savedAt` est une date ISO 8601. Le fichier JSON ne contient pas d'état d'interface, de logs, de clé `localStorage`, de handle fichier, de blob, de base64 ou de JSX.

## Validation runtime

Le module `app/lib/admin-draft-storage.ts` utilise les schémas partagés pour valider les brouillons locaux et les fichiers importés.

La validation rejette notamment :

- JSON malformé ;
- `schemaVersion` manquant ;
- version non supportée ;
- `savedAt` invalide ;
- section manquante ;
- champ du mauvais type ;
- champ inconnu ;
- ID technique modifié ;
- item répété manquant ou supplémentaire ;
- item répété réordonné ;
- source média de type invalide ;
- URL dangereuse comme `javascript:` ;
- email invalide ;
- structure incompatible avec le site actuel.

Les URLs éditables sont validées selon leur rôle :

- ancres internes pour la navigation interne ;
- URLs Instagram HTTPS pour les liens Instagram ;
- `mailto:` valide pour les liens email ;
- chemins publics commençant par `/` ou URLs `http(s)` pour les sources médias.

## Sauvegarde et restauration

La sauvegarde locale est explicite via `Enregistrer le brouillon local`. Elle valide le contenu courant, crée une enveloppe `schemaVersion: 1`, écrit le JSON dans `localStorage` et marque l'état comme propre.

À l'ouverture de `/admin`, le brouillon local est lu après le montage client pour éviter les problèmes d'hydratation. Si le brouillon est valide, son contenu remplace l'état initial et devient la base propre. Sinon, le contenu par défaut reste affiché et l'interface propose de supprimer le brouillon invalide.

## État modifié

Toute modification d'un champ marque l'éditeur comme `Modifications non enregistrées`. Une sauvegarde réussie efface cet état. Un import JSON est considéré comme non enregistré tant qu'il n'a pas été sauvegardé localement.

Une protection `beforeunload` est active uniquement quand des modifications non enregistrées existent.

## Suppression et reset

`Supprimer le brouillon local` retire seulement la clé `eszter:admin-content-draft:v1`. Le contenu actuellement visible dans l'éditeur reste en mémoire jusqu'au reset ou au rafraîchissement.

`Réinitialiser les modifications` restaure le contenu courant à `defaultSiteContent` sans supprimer le brouillon local enregistré.

## Import et export JSON

`Exporter le brouillon JSON` télécharge le contenu actuellement visible, y compris les modifications non enregistrées, dans une enveloppe `SiteContentDraftV1`. Le nom de fichier suit le format :

```text
eszter-content-draft-YYYY-MM-DD-HHmm.json
```

`Importer un JSON` lit un fichier local `.json` de 1 Mo maximum. Le fichier est analysé et validé avant de remplacer l'état éditeur. L'import exige une confirmation, ne sauvegarde pas automatiquement dans `localStorage` et ne fait aucun appel réseau.

## Champs éditables

L'interface permet de modifier les textes visibles, les libellés de liens, certaines URLs de contact/social, les sources d'images et les textes alternatifs.

Les champs image acceptent uniquement une URL ou un chemin public saisi manuellement. Il n'y a pas encore d'upload, de stockage de fichier ou de conversion base64.

## Éléments fixes

Cette passe ne permet pas de modifier :

- l'ordre des sections ;
- le nombre de sections ;
- le nombre d'items répétés ;
- les IDs techniques ;
- les styles, couleurs, espacements, animations et breakpoints ;
- les comportements techniques de navigation interne.

## Sécurité et futur backend

La route `/admin` n'a pas encore d'authentification ni d'autorisation. Elle sert à valider le contrat et l'ergonomie avant l'intégration backend.

Le module de persistance locale isole les opérations de sauvegarde, chargement, suppression, sérialisation et validation. Il pourra être remplacé plus tard par un dépôt appuyé sur une API Express exposant le même contrat `SiteContent`.
