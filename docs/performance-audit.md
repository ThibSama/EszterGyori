# Audit performance frontend

> **Audit anterieur au paquet 2.1 (ESZ-020/021).** Il decrit le frontend tel qu'il
> etait avec un runtime Node : rendu serveur de `/`, ISR, middleware, `CONTENT_API_URL`.
> Le frontend est desormais un export statique et PHP sert `/`. Ce document est
> conserve comme releve date, pas comme description de l'etat actuel.
> Voir `docs/static-frontend-and-injection.md`.


Date: 2026-06-14

> **Document historique.** Cette passe a ete executee alors que le depot contenait
> encore le service Express `API/` et son image Docker, supprimes au paquet 1.2
> (ESZ-015). Les commandes ci-dessous sont conservees telles qu'executees a l'epoque :
> l'etape `docker build` n'existe plus. Les conclusions frontend restent valables, et
> la validation Lighthouse reste a refaire sur l'hebergement final (Hetzner, et non
> Vercel — voir `docs/hetzner-target-architecture.md`).

## Portee

Audit centre sur le rendu public Next.js de `/`, avec verification de non-regression sur les routes admin protegees, l'aperçu admin et les frontieres public/admin. Aucun changement de contrat, d'API, d'authentification, de contenu ou de style fonctionnel n'a ete introduit.

## Baseline locale

Etat initial controle depuis un arbre Git propre:

- `contracts`: `npm ci`, `npm run typecheck`, `npm run build` passes.
- `front`: `npm ci`, `npm run test`, `npm run lint`, `npm run build` passes apres suppression de deux processus Next.js locaux qui verrouillaient un binaire genere dans `node_modules`.
- `API`: `npm ci`, `npm run typecheck`, `npm run build`, `npm run test` passes.
- Docker API: `docker build --progress=plain -f API/Dockerfile -t eszter-api:local .` passe.

Le build frontend produit toujours le log attendu lorsque `CONTENT_API_URL` pointe vers un exemple indisponible:

```text
Public content fallback { reason: 'CONTENT_API_NETWORK_FAILURE', hostname: 'api.example.com' }
```

## Analyse des assets

Mesure apres build production, avant optimisation:

| Type | Nombre | Octets |
| --- | ---: | ---: |
| JS | 17 | 1 297 682 |
| CSS | 1 | 89 279 |
| Fonts | 21 | 405 548 |
| Static total | - | 1 818 440 |

Mesure apres suppression de la police mono inutilisee:

| Type | Nombre | Octets |
| --- | ---: | ---: |
| JS | 17 | 1 297 682 |
| CSS | 1 | 87 382 |
| Fonts | 15 | 335 032 |
| Static total | - | 1 746 027 |

Gain conserve:

- 6 fichiers WOFF2 en moins.
- 70 516 octets de fonts en moins.
- 72 413 octets statiques en moins.
- Aucun changement de taille JS.

## Optimisation appliquee

La police `Geist_Mono` et la variable CSS `--font-mono` ont ete retirees parce qu'aucune source applicative ne les utilisait. La police sans-serif et la police display restent inchangées.

Cette optimisation est conservee car elle supprime des assets generes sans changer le rendu visible connu.

## Frontieres public/admin

Le code public inspecte ne reference pas les modules admin suivants:

- `content-editor`
- `admin-preview-viewport`
- `admin-draft-storage`
- `admin-appearance-editor`
- `auth/session`
- `localStorage`

Un test automatise garde cette isolation sur les sources publiques principales.

## Mesure navigateur locale

Une mesure Chrome headless locale a ete effectuee contre `http://localhost:3100/` en build production. Elle sert d'indication de non-regression locale, pas de score Lighthouse officiel.

| Largeur | FCP | LCP observe | CLS | Overflow horizontal | Lien public `/admin` |
| ---: | ---: | ---: | ---: | --- | --- |
| 390 px | 312 ms | 312 ms | 0 | non | non |
| 768 px | 192 ms | 192 ms | 0 | non | non |
| 1440 px | 1 948 ms | 1 948 ms | 0 | non | non |

La mesure 1440 px a montre un TTFB local plus eleve pendant cette execution. Elle n'a pas ete utilisee comme preuve Core Web Vitals definitive.

## Optimisations rejetees ou reportees

Les changements suivants ont ete explicitement rejetes pendant ce passage:

- prechargement manuel d'images sans mesure prouvant un gain LCP;
- suppression ou reecriture des animations;
- conversion generale de composants client en composants serveur;
- reecriture Tailwind ou refonte visuelle;
- ajout de Lighthouse, bundle analyzer ou autre dependance;
- modification du loader `CONTENT_API_URL`;
- optimisation d'images de contenu qui changerait le rendu ou la source canonique.

## Limites

Lighthouse CLI n'etait pas disponible localement et aucune dependance n'a ete ajoutee pour l'installer. Les Core Web Vitals reels de production Vercel n'ont donc pas ete confirmes dans ce passage.

L'admin authentifie n'a pas ete valide dans le navigateur faute d'identifiants fournis. Les routes protegees ont en revanche ete controlees: `/admin` et `/admin/preview` redirigent vers `/admin/login`.

## Suivi recommande

La prochaine validation performance devrait etre faite sur le deploiement Vercel final, avec Lighthouse ou PageSpeed Insights, sur mobile et desktop, sans cache de build precedent.

---

# Package 8.2 — reproducible budgets (ESZ-085)

The audit above was a one-off reading of a Vercel deployment that no longer exists:
Package 2.1 replaced it with a static export served by Apache. Its numbers are kept
for the record and are not claims about the current target.

What replaces it is not another reading. It is a **gate**, because the failure worth
catching is not "this page is slow today" — it is "this page got slower and nobody
noticed", and a measurement taken once cannot catch that.

## `front:budgets`

`front/scripts/verify-budgets.mjs`, run by `npm run verify:budgets` after a build
and by `scripts/validate.mjs` as a Stage 5 gate. For every route it measures the
gzipped weight of the document plus every stylesheet and script it references, and
compares it against a declared ceiling.

Gzip, because that is what is transferred. Raw size is the wrong unit: minified
JavaScript compresses about four to one, so raw numbers overstate the cost of code
and understate the cost of anything already compressed — an inlined image, for
instance, which is exactly the regression a budget should catch.

Current measurements against their ceilings:

| Route | Transferred (gzip) | Ceiling |
| --- | --- | --- |
| `/` | 290 845 | 300 000 |
| `/` document only | 12 318 | 14 000 |
| `/reservation` | 287 646 | 300 000 |
| `/admin` | 303 821 | 315 000 |
| `/admin/bookings` | 288 447 | 300 000 |
| `/admin/availability` | 289 519 | 300 000 |
| `/admin/login` | 283 260 | 295 000 |
| All CSS | 14 229 | 15 000 |
| All JavaScript | 327 685 | 345 000 |

Every ceiling sits a few per cent above what the build produces. That is the design:
the gate is silent today and speaks the moment something grows. A budget with room
for a doubling would prove nothing, so raising one is a deliberate edit in the same
commit as the growth — which is the point, because it makes the increase reviewable
instead of absorbed.

`/` is the one route with a separate document budget. It is re-injected by PHP on
every request (ESZ-021) and is therefore never document-cached, so its HTML size is
paid on every single visit — a cost none of the other routes carry. The shared CSS
and JavaScript totals are broken out for the opposite reason: a regression there
lands on all six routes at once, and against per-route totals it reads as six small
regressions rather than one large one.

## Payload budgets

`front/tests/payload-budgets.test.ts` bounds the API payloads Packages 5.x–7.x
added. These are the first responses on this site whose size depends on **data**
rather than on the page — a slot list grows with the horizon, a booking list with
the range, a summary with its window — so the interesting size is never the one a
developer sees on a site with three bookings. Each budget is built at the
contract's own declared maximum:

- Availability at `BOOKING_SLOT_MAX_RESULTS`: under 200 kB raw, under 12 kB gzipped.
- A single slot: under 160 bytes. The per-item budget is the one that catches a
  field being added — at the maximum result count, one extra 40-byte field is 40 kB
  on the wire, which reads as noise against the whole-response budget.
- Admin bookings at four per day across the full 90-day range, with every optional
  customer field populated: under 250 kB raw, under 20 kB gzipped.
- The operations summary at its maximum window: under 90 kB raw, under 4 kB gzipped.
- A weekly availability replacement at `ADMIN_AVAILABILITY_MAX_WEEKLY_RULES`: under
  16 kB, and asserted to fit through `REQUEST_BODY_LIMIT` — otherwise the editor
  could build a set the server refuses to read.

The test also asserts that every declared query bound is finite and small enough to
actually bound something. A bound that is not enforced is not a bound, and one so
large no caller could reach it is decoration.

## Query bounds (ESZ-085 fix)

`BookingRepository::listBetween()` bounded its date range and nothing else. A range
is not a bound on rows: how many bookings fall inside 90 days is decided by how busy
the site is, not by the query, so both the response size and the memory the method
allocated were unbounded. It now carries `LIMIT booking.policy.limits.maxResults` —
the same ceiling the slot engine applies to the other unbounded list on this
surface, so the two cannot drift into different ideas of "too many". Proved by
`sql:integration`.

## What is still NOT RUN

No Lighthouse score, no Core Web Vitals, no field data, no device testing. There is
no browser runner in this repository and none was added, because a number produced
by inventing a runner is worse than an absent one. `docs/v1-quality-gates.md` keeps
Stage 9 at NOT RUN, and NOT RUN is never a pass.

The budgets above are arithmetic over built bytes and payload shapes. That is
exactly as much as they claim.
