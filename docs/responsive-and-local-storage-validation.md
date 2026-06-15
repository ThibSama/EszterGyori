# Responsive and Browser-Local Draft Validation

Audit date: 2026-06-15

Commit audited: `f9368bc`

Runtime versions:

- Node.js: `v24.11.1`
- npm: `11.6.2`
- Next.js: `16.2.9`

## Scope

This pass covers responsive validation of the public Next.js frontend and the accessible admin interface, plus clearer user-facing communication about browser-local draft storage.

No backend publication, API admin route, media upload, schema change, metadata change, or visual redesign is included.

## Baseline

Production PageSpeed state provided before this pass:

- Desktop: 100 performance, 100 accessibility, 100 best practices, 100 SEO
- Mobile: 97 performance, 100 accessibility, 100 best practices, 100 SEO

Local baseline before implementation:

- Contracts: `npm ci`, `npm run typecheck`, `npm run build` passed
- Frontend: `npm ci`, `npm run test`, `npm run lint`, `npm run build` passed
- API: `npm ci`, `npm run typecheck`, `npm run build`, `npm run test` passed
- Docker: `docker build --progress=plain -f API/Dockerfile -t eszter-api:local .` passed

Known audit-only notes:

- Frontend install reports two moderate npm audit findings.
- API install reports one high npm audit finding.
- These dependency advisories were not changed in this pass.

## Routes

Public routes:

- `/`

Admin routes:

- `/admin`
- `/admin/login`
- `/admin/preview`

Authenticated admin runtime validation depends on local credentials. When credentials are unavailable, redirects, `/admin/login`, source structure, and protected-preview implementation are validated instead.

## Viewport Matrix

Target widths:

- 320 px
- 360 px
- 375 px
- 390 px
- 430 px
- 768 px
- 820 px
- 1024 px
- 1280 px
- 1440 px
- 1920 px

Device groups:

- phone portrait
- phone landscape
- tablet portrait
- tablet landscape
- laptop
- desktop
- large desktop

Zoom and reflow:

- 200% browser zoom
- 400% zoom where practical
- 320 CSS px equivalent width

## Current Breakpoint Behavior

Public route:

- Navigation uses a fixed transparent wrapper and an inner rounded glass surface.
- Mobile navigation is rendered only when open, and body scroll is locked during the open state.
- Public sections use responsive Tailwind grids and bounded max-width containers.
- Section backgrounds and ambient shapes are scoped to `SitePreview`.

Admin route:

- The editor and preview collapse into a single column before the `xl` breakpoint.
- The preview uses a protected same-origin iframe and scales its visual frame down inside the available panel.
- Existing preview modes before this pass were phone and desktop only.

## Current Admin Information Architecture

Before this pass, the admin header contained:

- page title;
- a technical paragraph about local browser storage and missing API admin integration;
- a three-column status card containing current state, local draft, and the raw storage key;
- action buttons for preview, save, export, import, reset, and delete.

The explanation was accurate but dense, and the technical storage key was too prominent for a non-technical user.

## Storage Model

The user-facing model must be:

```text
Editor changes
    ↓ save
Local draft in this browser only
    ↓ export
Portable JSON backup
```

Separately:

```text
Public website
    remains unchanged
```

The admin must clearly state that saving does not publish the site, does not send data to a server, and only keeps the draft in the current browser profile on the current device.

## Findings Before Implementation

### MEDIUM - Admin Preview Lacks Tablet Mode

Route: `/admin`

Viewport: all admin editor widths

Component: `AdminPreviewViewport`

Observed problem: preview controls expose phone and desktop only.

User impact: Esther cannot verify tablet layout from the editor even though tablet breakpoints are a required validation target.

Proposed correction: add a native button mode labelled `Tablette` with a 768 x 1024 viewport.

Risk: low. This is local UI state only and uses the existing iframe messaging.

Validation method: source inspection, tests for labels/dimensions/`aria-pressed`, runtime preview scaling.

### MEDIUM - Browser-Local Storage Copy Is Too Technical

Route: `/admin`

Viewport: all widths

Component: `ContentEditor`

Observed problem: the primary notice explains local storage accurately, but mixes user guidance with implementation/backend limitations. The storage key appears in the primary status summary.

User impact: saving may still be confused with publishing, server persistence, or synchronization across devices.

Proposed correction: add a calm primary notice, a simple state summary, clearer action labels, a JSON backup explanation, and move implementation details into a native `<details>` element.

Risk: medium. Copy must match existing behavior exactly and must not change JSON format, local draft key, reset semantics, or import/export behavior.

Validation method: source inspection, targeted tests, runtime admin layout checks.

### LOW - Preview Mode Control Can Wrap More Safely at 320 px

Route: `/admin`

Viewport: 320 px

Component: `AdminPreviewViewport`

Observed problem: adding a third mode requires the segmented control to wrap without forcing horizontal overflow.

User impact: preview controls could become compressed on narrow phones.

Proposed correction: use flex-wrap and compact padding while preserving native buttons.

Risk: low.

Validation method: source inspection and runtime width checks.

### DEFER - Real Device and Safari Validation

Route: all

Viewport: physical devices and Safari

Component: browser rendering stack

Observed problem: this environment provides Chromium-based local validation. Safari and physical-device validation require external devices/browsers.

User impact: standards-based source review can reduce risk but cannot replace Safari/device testing.

Proposed correction: document as a remaining validation step.

Risk: none for code.

Validation method: documentation only.

## Implemented Corrections

Implemented frontend corrections:

- Added a real tablet preview mode to `AdminPreviewViewport`.
- Updated preview dimensions:
  - Phone: 390 x 844
  - Tablet: 768 x 1024
  - Desktop: 1280 x 860
- Kept the same protected iframe route, same-origin `postMessage`, and validated `SiteContent` payload.
- Made the preview mode control wrap safely on narrow screens.
- Replaced the dense primary admin storage notice with a clearer browser-local draft explanation.
- Split the admin state summary into:
  - Modifications
  - Brouillon sur cet appareil
  - Site public
- Moved the technical storage key into a native `<details>` disclosure.
- Renamed admin action labels to avoid implying publication.
- Added a portable JSON backup explanation near export.
- Added safe wrapping for technical IDs and color values.
- Added `scroll-margin-top` for public anchor targets so the fixed navbar does not cover target sections.

## Final Responsive Results

Chrome headless production validation was run against `http://localhost:3100`.

Validated public widths:

- 320 px
- 360 px
- 375 px
- 390 px
- 430 px
- 768 px
- 820 px
- 1024 px
- 1280 px
- 1440 px
- 1920 px

Validated route:

- `/`

Results:

- No horizontal overflow at any tested width.
- Navigation remains within the viewport.
- Mobile navigation is visible from 320 px through 430 px.
- Desktop navigation is visible from 768 px and above.
- No duplicate visible navigation was detected.
- Hero, reassurance, services, process, gallery, about, contact, and footer sections keep full viewport width without page overflow.
- Large desktop widths keep the navbar capped at its intended max width.

Orientation checks:

- Phone landscape: 844 x 390, no horizontal overflow.
- Tablet portrait: 768 x 1024, no horizontal overflow.
- Tablet landscape: 1024 x 768, no horizontal overflow.
- Laptop: 1280 x 800, no horizontal overflow.

Public section checks:

- Navigation: rounded glass bubble remains intact, no rectangular tint regression.
- Hero: no 320 px clipping; short landscape remains scrollable rather than trapped in a fixed-height layout.
- Reassurance: one-column phone layout and two-column larger layout remain readable.
- Services: cards remain inside the viewport at 320 px.
- Process: step cards keep logical order and do not collide.
- Gallery: grid remains contained; no horizontal overflow at narrow widths.
- About: portrait placeholder keeps its aspect ratio and columns collapse.
- Contact: buttons and card remain contained.
- Footer: content wraps without overflow.

## Local Draft Copy

Final primary notice:

```text
Brouillon enregistré uniquement sur cet appareil

Enregistrer conserve le brouillon dans ce navigateur uniquement.
Le site public n'est pas modifié.
Pour sauvegarder ou transférer le travail, exportez le fichier JSON.

La suppression des données du navigateur ou l'utilisation de la navigation privée peut supprimer le brouillon.
```

State summary:

- Modifications
- Brouillon sur cet appareil
- Site public

Displayed states include:

- `Modifications non enregistrées`
- `Aucune modification non enregistrée`
- `Dernier enregistrement : …`
- `Aucun brouillon enregistré sur cet appareil`
- `Inchangé`

The public site is explicitly separated from the editor draft state.

## Import and Export

JSON behavior was preserved:

- The same draft serializer is used.
- The same parser and size limit are used.
- The same filename helper is used.
- Imported content appears in the editor and preview.
- Imported content is marked as unsaved until the user chooses local save.
- Export creates a portable JSON backup of the content currently displayed in the editor.

Final export explanation:

```text
Sauvegarde portable : fichier JSON.
Le fichier exporté peut être gardé comme sauvegarde, envoyé à une autre personne ou importé dans un autre navigateur.
```

## Reset and Delete

Reset and delete remain distinct:

- `Restaurer le contenu d'origine` restores canonical content in the editor and deletes the local browser draft.
- `Supprimer le brouillon de cet appareil` deletes the stored browser draft without claiming any public-site change.

The reset confirmation now says the public site remains unchanged.

The delete confirmation now says the deletion is local to this device/browser and that the public site remains unchanged.

## Accessibility Non-Regression

Validated in Chrome:

- One public `main`.
- One public `h1`.
- Skip link becomes visible on keyboard focus.
- Heading hierarchy remains sequential.
- Primary navigation remains labelled.
- Closed mobile menu is absent from the DOM/accessibility tree.
- Open mobile menu is exposed as a labelled mobile navigation.
- Escape closes the menu.
- Focus returns to the menu trigger.
- Visible focus remains.
- Status and error live regions remain in the admin source.
- Reduced motion CSS remains present.
- Preview iframe title remains present.
- Preview buttons retain `aria-pressed`.

`/admin/login`:

- One `main`.
- One `h1`.
- Username and password labels remain visible.
- Submit button keeps the accessible name `Se connecter`.

## Performance Non-Regression

Static asset totals after this pass:

- JavaScript: 1,303,753 bytes
- CSS: 88,856 bytes
- Fonts: 335,032 bytes
- Other static assets: 26,255 bytes
- Total static assets: 1,753,896 bytes

Previous recorded local static totals after the accessibility pass:

- JavaScript: 1,302,032 bytes
- CSS: 88,139 bytes
- Fonts: 335,032 bytes
- Total static assets: 1,751,458 bytes

Delta:

- JavaScript: +1,721 bytes
- CSS: +717 bytes
- Fonts: unchanged
- Total static assets: +2,438 bytes

The increase is small and explained by the admin-only tablet preview mode, clearer admin copy, tests, and the public anchor `scroll-margin-top` rule. No third-party dependency, public body image, tracker, or metadata change was added.

## Remaining Limitations

- Authenticated `/admin` runtime validation was not completed because no clear local admin password was available. `/admin` and `/admin/preview` were validated as protected redirects, and the protected admin source was audited statically.
- Firefox is installed, but headless screenshot validation timed out in this environment. No Firefox success is claimed.
- Safari is unavailable on this Windows environment. Safari behavior is covered only by standards-based source review.
- Physical-device validation was not performed.
- Final client photography is still unavailable.
- Long temporary content was tested in the DOM without committing it. Reasonable content-length limits remain: very long navigation labels or CTA labels may wrap and increase component height, but should not create horizontal page overflow.
- There is still no server publication workflow. A future backend migration should introduce authenticated server drafts and publication without changing the current JSON import/export compatibility unnecessarily.
