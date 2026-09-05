# Audit accessibilite de base

Date: 2026-06-15

## Portee

Cette passe couvre les corrections d'accessibilite de base du frontend Next.js:

- page publique `/`;
- page `/admin/login`;
- structure de landmarks;
- lien d'evitement;
- hierarchie des titres;
- navigation desktop et mobile;
- comportement clavier du menu mobile;
- focus visible;
- formulaires et messages dynamiques;
- reduction des animations;
- contrastes de la palette par defaut;
- zoom, reflow et espacement de texte;
- audit statique de l'aperçu admin.

Cible: WCAG 2.2 AA pour les points controles dans cette passe.

## Avertissement de non-certification

Ce document n'est pas une certification d'accessibilite et ne remplace pas un audit manuel complet avec technologies d'assistance reelles. Il documente les corrections et validations effectuees localement sur le code actuel.

Score PageSpeed initial connu avant cette passe: 96 en accessibilite.

## Landmark structure

Avant:

- la page publique rendait les sections directement sous le conteneur `SitePreview`;
- aucun landmark `<main>` public n'etait present;
- Lighthouse signalait: `Document does not contain a main landmark`.

Apres:

- la page publique expose exactement un `<main id="main-content" tabIndex={-1}>`;
- la navigation principale reste dans un `<nav aria-label="Navigation principale">`;
- le footer reste expose comme contenu de fin de page;
- l'arbre d'accessibilite Chrome contient 1 role `main` et 1 role `contentinfo`.

## Hierarchie des titres

Avant:

- la page commencait par un `h1`;
- la section de reassurance affichait directement plusieurs `h3`;
- Lighthouse signalait: `Heading elements are not in sequentially descending order`.

Apres:

- `h1`: titre hero public;
- `h2` masque: `Pourquoi choisir Eszter Gyori`;
- `h3`: cartes de reassurance;
- sections suivantes: `h2` visibles puis `h3` internes.

Le `h2` masque est semantique: il nomme le groupe de raisons de confiance qui suit. Il n'est ni vide, ni generique, ni ajoute uniquement pour satisfaire un outil.

## Lien d'evitement

Implementation:

- lien `Aller au contenu principal`;
- cible `#main-content`;
- visible uniquement au focus;
- position fixe au-dessus du contenu;
- focus teste a 200% de zoom.

Correction finale: le masquage utilise `top: -6rem` et non un transform vertical, afin que le lien reste effectivement visible au focus dans Chrome a 200% de zoom.

## Navigation mobile

Avant:

- le panneau ferme restait monte dans le DOM avec `pointer-events-none`;
- pas de fermeture clavier par `Escape`;
- pas de restauration explicite du focus.

Apres:

- panneau ferme absent du DOM;
- bouton hamburger nomme par `aria-label`;
- `aria-expanded` et `aria-controls` presents;
- menu ouvert expose un `nav aria-label="Navigation mobile"`;
- ouverture: focus place sur le premier lien;
- `Escape`: fermeture du menu et focus restaure au bouton;
- clic backdrop: fermeture et restauration du focus;
- body scroll lock conserve pendant l'ouverture.

Validation Chrome/CDP:

- menu ferme: `mobile-navigation-menu` absent;
- menu ouvert: `Navigation mobile` present dans l'arbre;
- `Escape`: `aria-expanded=false`, menu absent, focus sur `Ouvrir le menu`.

## Focus visible

Convention ajoutee:

- focus visible global pour liens, boutons, champs et elements avec `tabindex`;
- outline de 3 px;
- couleur par defaut `#63726C`;
- fallback present hors variables d'apparence.

Le lien d'evitement utilise une couleur dediee `#9EA9A4` avec offset visible.

## Formulaires et live regions

`/admin/login`:

- un `<main>`;
- un `h1`;
- label explicite `Identifiant`;
- label explicite `Mot de passe`;
- bouton submit nomme `Se connecter`;
- erreur exposee via `role="alert"`.

Editeur admin:

- message de statut expose via `role="status"` et `aria-live="polite"`;
- erreurs exposees via `role="alert"`.

## Reduced motion

Avant:

- les animations ambiantes et hero respectaient deja `prefers-reduced-motion`;
- le scroll smooth global restait actif.

Apres:

- `prefers-reduced-motion: reduce` coupe aussi `scroll-behavior` via `scroll-behavior: auto !important`;
- les animations ambiantes, flottantes et d'entree restent desactivees dans ce mode.

## Contrast ratios

Mesures effectuees sur la palette par defaut.

| Cas | Premier plan | Fond | Ratio | Seuil |
| --- | --- | --- | ---: | ---: |
| Texte principal | `#2C2B28` | `#F5F4F1` | 12.87:1 | 4.5:1 |
| Texte secondaire | `#6D6B67` | `#F5F4F1` | 4.83:1 | 4.5:1 |
| Texte navbar | `#6D6B67` | `#FAFAF8` | 5.09:1 | 4.5:1 |
| Bouton principal | `#FAFAF8` | `#2C2B28` | 13.55:1 | 4.5:1 |
| Bouton secondaire | `#565451` | `#F8F7F5` | 7.05:1 | 4.5:1 |
| Footer apres correction | `#565451` | `#E8E6E3` | 6.06:1 | 4.5:1 |
| Indicateur de focus | `#63726C` | `#F5F4F1` | 4.60:1 | 3.0:1 |
| Erreur login | `#B91C1C` | `#FEF2F2` | 5.91:1 | 4.5:1 |

Le footer utilisait auparavant `#ADABA6` sur un fond proche de `#E8E6E3`, soit environ 1.84:1. Il a ete corrige vers `text-warm-600`.

Les palettes personnalisees disposent deja de validations de contraste dans le contrat d'apparence pour les couples principaux. Cette passe ne peut toutefois pas garantir universellement chaque combinaison visuelle possible sans etendre les validations contractuelles a tous les usages effectifs des tokens.

## Zoom et reflow

Validation Chrome/CDP:

- largeur 320 CSS px: pas de debordement horizontal;
- navbar utilisable, largeur mesuree 288 px dans un viewport 320 px;
- bouton de menu visible;
- zoom 200%: pas de debordement horizontal;
- skip link visible au focus a 200%;
- stress test temporaire non commite:

```css
line-height: 1.5 !important;
letter-spacing: 0.12em !important;
word-spacing: 0.16em !important;
```

Resultat du stress test:

- pas de debordement horizontal;
- 15 controles visibles;
- 0 controle visible a taille nulle;
- navbar et menu toujours accessibles.

## Accessibility tree

Page publique `/`:

- 1 role `main`;
- 1 `h1` public;
- navigation principale nommee `Navigation principale`;
- menu mobile ferme absent de l'arbre;
- menu mobile ouvert expose `Navigation mobile`;
- bouton de menu nomme `Ouvrir le menu` / `Fermer le menu`;
- decor ambiant absent de l'arbre grace a `aria-hidden="true"`;
- footer expose comme `contentinfo`.

`/admin/login`:

- 1 role `main`;
- 1 `h1` `Connexion`;
- champs nommes `Identifiant` et `Mot de passe`;
- bouton `Se connecter`;
- erreur presente via `role="alert"`.

## Lighthouse

Lighthouse CLI n'est pas disponible localement:

- `Get-Command lighthouse` ne retourne rien;
- aucun package `lighthouse` n'est installe dans `front/node_modules`;
- aucune dependance n'a ete installee pendant cette passe.

Score Lighthouse local final: non mesure.

Les deux constats precedents ont ete controles comme resolus par DOM et arbre d'accessibilite Chrome:

- `Document does not contain a main landmark`: resolu, 1 role `main`;
- `Heading elements are not in sequentially descending order`: resolu, outline `h1 -> h2 -> h3`.

Un passage Lighthouse/PageSpeed doit etre relance apres deploiement pour obtenir le score final officiel.

## Performance non-regression

Mesure des assets `.next/static` apres cette passe:

- total statique: 1 751 458 octets;
- JS: 1 302 032 octets;
- CSS: 88 139 octets;
- fonts: 335 032 octets;
- fonts: 15 fichiers.

Comparaison avec la mesure metadata/performance precedente connue:

- total statique precedent: 1 749 808 octets;
- JS precedent: 1 300 945 octets;
- CSS precedent: 87 576 octets.

Variation:

- total: +1 650 octets;
- JS: +1 087 octets, lie au comportement clavier/focus du menu mobile existant;
- CSS: +563 octets, lie au skip link et focus visible;
- aucune nouvelle dependance;
- aucune image chargee dans le body;
- aucun changement API, contrat ou authentification.

## Audit statique apercu admin

`AdminPreviewViewport`:

- iframe: `title="Aperçu en direct du site"`;
- controles de mode: boutons natifs;
- etat selectionne: `aria-pressed`;
- groupe: `aria-label="Mode d’aperçu"`;
- controles clavier-operables car boutons natifs;
- `postMessage` utilise `window.location.origin`.

`admin-preview-messaging.ts`:

- validation origine: `event.origin !== expectedOrigin`;
- validation source: `event.source !== expectedSource`;
- validation schema: `siteContentSchema.safeParse`;
- type stable: `ESZTER_ADMIN_PREVIEW_CONTENT`.

Validation runtime authentifiee de `/admin` non effectuee faute d'identifiants fournis. L'authentification n'a pas ete affaiblie.

## Limitations restantes

- Pas de score Lighthouse local final sans outil disponible.
- Pas de test avec lecteur d'ecran reel.
- Pas de validation sur appareils physiques.
- Pas d'audit complet de toutes les combinaisons de palettes personnalisees.
- L'admin authentifie et l'iframe preview n'ont pas ete testes en runtime authentifie faute d'identifiants.

---

# Package 8.2 — automated coverage for the booking surfaces (ESZ-085)

The audit above covers the public site and the content editor as they stood before
Packages 5.x–7.x. Those packages added the first screens on this site that are
**forms with server-decided errors** rather than pages of copy — the reservation
flow, the booking calendar, the availability editor, the operations summary — and
that is where the remaining accessibility risk now lives: a field whose error is
announced to nobody, a step change that moves focus nowhere, a control that is a
`<div>` with a click handler.

ESZ-085 strengthens the automated coverage over those surfaces and fixes two real
defects it surfaced. It does not redesign any accepted UI.

## Two defects found and fixed

**The month calendar claimed an ARIA pattern it did not implement.** It carried
`role="grid"` with `role="columnheader"` and `role="gridcell"` children and **no
`role="row"` between them**. That is not a grid: those roles require rows, and
without them a screen reader is told about a structure that is not there. The grid
role additionally promises arrow-key navigation between cells, which the component
does not implement.

Claiming a pattern and then not honouring it is worse for someone relying on it
than claiming nothing, because they navigate as though the promise held. The roles
are gone and the layout is unchanged: the CSS grid still lays out seven columns,
each day is still a `<button>`, and Tab still reaches every one of them in reading
order.

What is added is the part that was actually missing. Each day button now carries an
accessible name — the full Paris-local date and how many appointments it holds —
instead of announcing a bare number followed by up to three truncated customer
names. The count matters as much as the date: "how busy is the 24th?" is the
question the month view exists to answer, and it was the one thing the visual
layout conveyed instantly and the text conveyed not at all. Selection is
`aria-current="date"` rather than `aria-selected`, which is not valid on a plain
button.

**A focus outline was removed with no visible replacement.** The operations
summary's error notice is a programmatic focus target (`tabIndex={-1}`) carrying
`focus:outline-none` and no `focus:ring-*`. Focus was moved there on failure with
nothing on screen to show it had moved. A focus ring was added.

## What the tests now assert

`front/tests/accessibility.test.ts`:

- **Every reservation field** is labelled with `htmlFor`, reports its own validity
  with `aria-invalid`, and is described by its own error with `aria-describedby`. A
  message in a paragraph below the input is an error only a sighted user has.
- **`type` and `autoComplete`** are present and correct. These are accessibility
  features, not conveniences: they are what gives a phone the right keyboard and
  what lets someone with a motor impairment fill the form from stored values
  instead of typing it.
- **`noValidate` is deliberate and paired.** The browser's own validation bubbles
  are unstyled, inconsistently announced, vanish on the next interaction and are in
  the browser's language rather than the site's. Turning them off is correct *only
  because* the fields carry `aria-invalid` and `aria-describedby` instead, so the
  two are asserted together.
- **A rejected submit moves focus**, and a step change moves focus. `aria-live`
  alone leaves a keyboard or screen-reader user on the button they just pressed,
  with the form apparently unchanged.
- **Selection is conveyed by state, not colour** — `aria-pressed` on slot and
  service choices — and every interactive control is a real `<button>`. A
  `<div onClick>` is neither focusable nor operable from a keyboard, and its absence
  is asserted across all five components.
- **Admin editors attach server-decided errors to the row that broke**, with
  `aria-invalid`, `aria-describedby`, `role="alert"` and a focus move. The
  availability editor's whole value is that attribution; if it is only visual, the
  person who most needs it does not get it.
- **Focus rings are never removed without replacement.** For each admin component
  the count of `focus:outline-none` must not exceed the count of `focus:ring-*`.
- **Asynchronous views announce themselves** — `aria-busy` during the wait,
  `role="status"` or `role="alert"` for the outcome, the difference being whether
  the person needs to be interrupted.
- **The calendar claims no pattern it does not implement**, asserted as the absence
  of the four roles removed above, so the defect cannot return unnoticed.

## What this proves, and what it does not

These are **source assertions**, and they are exact about their limits. They prove
the attribute is there, which is what regresses when a component is refactored.
They do not prove a screen reader says the right thing, that the reading order is
sensible, or that a keyboard path through the reservation flow is comfortable.

Since ESZ-113, real-browser runs close part of that gap without pretending to close
all of it. `browser:public`, `browser:admin` and `browser:booking` (Stage 9,
`docs/v1-quality-gates.md` §5) assert, on the exercised controls of the real
running site: keyboard reachability (the skip link first in the tab order and
visible on focus, a keyboard-only admin login, the reservation controls), the
promised focus movements (skip-link landing, mobile-menu open/close and Escape
restoration, review/confirmation/invalid-field/recovery-notice moves), live
`role=status`/`role=alert` semantics that actually update, consistent
`aria-expanded`/`aria-pressed` state, no fake grid ARIA, and 320 px reflow. What
they still do not prove is unchanged: an assistive-technology pass and a full
keyboard-only booking completion remain deployment-owned, because a headless
browser cannot speak for NVDA or VoiceOver.

## Still deployment-owned

- One pass with a real screen reader (VoiceOver or NVDA) over the reservation flow
  and the availability editor.
- Keyboard-only completion of a booking, end to end, on a real browser.
- Contrast verification of any custom palette an editor sets, since the appearance
  block is editorial and the audit above covers only the canonical colours.
