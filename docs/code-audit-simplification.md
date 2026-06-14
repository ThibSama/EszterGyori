# Code audit and simplification

Date: 2026-06-14

## Baseline

Repository state before this pass was clean:

- `git status --short`: no output
- `git diff --check`: passed
- `git diff --cached --name-only`: no output

Baseline validation:

- Frontend: `npm ci`, `npm run test`, `npm run lint`, `npm run build` passed after stopping stale local Next dev processes that locked `lightningcss`.
- Contracts: `npm ci`, `npm run typecheck`, `npm run build` passed.
- API: `npm ci`, `npm run typecheck`, `npm run build`, `npm run test` passed.
- Docker: `docker build --progress=plain -f API/Dockerfile -t eszter-api:local .` passed.

The expected frontend build fallback log for `CONTENT_API_NETWORK_FAILURE` remained present and was not treated as a failure.

## Inventory

Audited source areas:

- Frontend routes: `/`, `/admin`, `/admin/login`, `/admin/preview`, `/admin/auth/login`, `/admin/auth/logout`.
- Frontend server flow: `app/page.tsx` loads public content server-side and renders `SitePreview`.
- Admin flow: protected admin page renders `ContentEditor`; drafts remain browser-local; preview content is sent to protected same-origin iframe by `postMessage`.
- Authentication flow: middleware/proxy, login/logout handlers, session cookie helpers, password hashing and redirect helpers.
- Appearance flow: validated contract appearance values are mapped to scoped CSS variables in `SitePreview`.
- API flow: `index.ts` loads config and starts server; `server.ts` initializes storage before listening; `app.ts` wires middleware and routes; storage reads JSON envelopes and validates persisted content.

Initial metrics for `front/app`, `front/tests`, `API/src` and `API/tests`:

- Source files: 54
- Total lines: 5752
- Files over 250 lines: 4
- Files over 500 lines: 2
- Largest frontend files: `content-editor.tsx` at 1394 lines, `site-preview.tsx` at 602 lines.

Final metrics:

- Source files: 59
- Total lines: 5761
- Files over 250 lines: 4
- Files over 500 lines: 1
- `content-editor.tsx`: 1394 -> 1020 lines
- `site-preview.tsx`: 602 -> 463 lines

## Findings

### SAFE

- `front/app/components/navigation.tsx` had a client boundary even though it only renders static navigation markup and a client child (`MobileNav`). The boundary can be removed safely.
- `content-editor.tsx` mixed orchestration, form controls, appearance editing, media preview editing, cards and all section editors. The form controls, cards, media editor and appearance editor already formed clear internal responsibilities and could be extracted without changing behavior.
- `site-preview.tsx` mixed all public section rendering. The gallery area already formed a self-contained section with its own helper components and could be extracted without changing DOM order or classes.
- API source is small and explicit. Current request flow is easy to trace; no safe simplification was found that would reduce complexity without increasing response/header risk.

### REQUIRES CARE

- Further splitting `content-editor.tsx` into each section editor would improve navigation but touches many repeated update callbacks and placeholder strings. This should be done only with focused UI regression checks.
- Further splitting `site-preview.tsx` by all public sections is feasible but mostly moves large Tailwind blocks. It should be staged section by section to keep visual diffs reviewable.
- `admin-draft-storage.ts` is moderately large because it centralizes draft schema, import parsing and storage behavior. It should remain intact unless import/export behavior is being changed deliberately.

### DEFER

- Generic schema-driven admin forms: would hide field-specific copy and callbacks and risks behavior changes.
- Generic API controller/service/repository layers: unnecessary for two public endpoints and JSON storage.
- Broad Tailwind class rewriting: high visual-regression risk.
- Performance-specific rewrites, metadata, accessibility audit, complete responsive validation, backend deployment, API authentication, server-side drafts, publication and media upload.

## Implemented simplifications

- Removed `"use client"` from `navigation.tsx`; `MobileNav` keeps the browser-only boundary.
- Extracted reusable admin field primitives into `front/app/components/admin/editor-fields.tsx`.
- Extracted reusable admin card primitives into `front/app/components/admin/editor-cards.tsx`.
- Extracted media editing and image preview state into `front/app/components/admin/media-editor.tsx`.
- Extracted appearance editing and color validation UI into `front/app/components/admin/appearance-editor.tsx`.
- Extracted public gallery rendering into `front/app/components/site-gallery-section.tsx`.

No API source changes were implemented. The API was intentionally left explicit and unchanged.

## Client boundaries

Retained:

- `content-editor.tsx`: React state/effects, file input, localStorage workflow, import/export and browser unload handling.
- `admin-preview-viewport.tsx`: iframe refs, `ResizeObserver`, postMessage and local preview mode state.
- `admin-preview-client.tsx`: receives preview messages and stores preview content in client state.
- `mobile-nav.tsx`: hamburger state, portal and body scroll lock.
- `reveal.tsx`: `IntersectionObserver` and DOM refs.
- `hero-instagram-button.tsx`: user-agent and app-link behavior.

Removed:

- `navigation.tsx`: static shell can be server-rendered while including the `MobileNav` client child.

## API audit

Runtime flow:

```text
environment
-> loadConfig
-> createContentStorage
-> initialize draft/published files
-> createApp with published content reader
-> register routes and error handler
-> listen
-> graceful shutdown on SIGINT/SIGTERM
```

The API has useful small modules:

- `config.ts`: environment validation.
- `request-id.ts`: request ID generation and propagation.
- `http-error.ts`: shared error body shape.
- `routes/public-content.ts`: public content ETag/cache behavior.
- `storage/*`: JSON file validation and atomic writes.

No controller, service, repository or DI abstraction is justified at the current surface area.

## Behavior preservation

This pass did not intentionally change:

- routes, methods, status codes, headers or response bodies;
- API storage semantics, atomic writes, ETags or startup behavior;
- authentication, cookies, login, logout or redirects;
- content schemas, stable IDs, default content or appearance model;
- local drafts, import/export, reset or preview messaging;
- public section order, Tailwind classes, animations or navbar glassmorphism.

## Deferred work

- Performance optimization
- Metadata, favicon and social previews
- Accessibility audit
- Complete responsive validation
- Admin client-validation messaging improvements
- Backend deployment
- API authentication
- Server-side drafts
- Publication
- Media upload
