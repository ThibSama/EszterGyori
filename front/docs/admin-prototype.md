# Prototype d'administration frontend

La route `/admin` fournit un editeur de contenu cote frontend pour le site vitrine Eszter. Elle utilise le contrat partage `SiteContent` sans authentification, sans publication et sans stockage serveur.

Un service Express minimal existe maintenant dans `API/`, mais `/admin` ne l'appelle pas. Le service expose uniquement `GET /api/health`.

## Contrat partage

Le contrat runtime est defini hors de `front/app/`, dans `front/contracts/`.

- `front/contracts/site-content.ts` definit le schema strict `siteContentSchema`.
- `front/contracts/content-envelopes.ts` definit les enveloppes versionnees.
- `front/app/types/site-content.ts` re-exporte les types inferes pour conserver les imports frontend existants.

La dependance de validation runtime est `zod`, declaree directement dans `front/package.json`.

## Rendu et apercu

Le site public et l'apercu admin consomment le meme composant `SitePreview`.

- La homepage publique passe toujours `defaultSiteContent`.
- `/admin` passe l'etat edite en memoire.
- Les changements admin ne modifient jamais `/`.
- Aucun appel API n'est effectue depuis l'admin.

## Etat local

L'editeur initialise son etat avec une copie independante de `defaultSiteContent` via `structuredClone`, puis verifie cote client si un brouillon local existe.

Le stockage local utilise uniquement cette cle :

```text
eszter:admin-content-draft:v1
```

Le brouillon local est specifique au navigateur courant. Il n'est pas disponible sur un autre appareil, n'est pas envoye a un serveur et ne publie pas le site public.

## Validation runtime

Le module `front/app/lib/admin-draft-storage.ts` utilise les schemas partages pour valider les brouillons locaux et les fichiers importes.

La validation rejette notamment :

- JSON malforme ;
- `schemaVersion` manquant ;
- version non supportee ;
- `savedAt` invalide ;
- section manquante ;
- champ du mauvais type ;
- champ inconnu ;
- ID technique modifie ;
- item repete manquant ou supplementaire ;
- item repete reordonne ;
- source media de type invalide ;
- URL dangereuse comme `javascript:` ;
- email invalide ;
- structure incompatible avec le site actuel.

## Sauvegarde, import et export

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

Le module de persistance locale pourra etre remplace plus tard par un depot appuye sur une API Express exposant le meme contrat `SiteContent`.
