# 5. Cookies, browser storage and trackers — review (V1)

Method: static inspection of the committed frontend (`front/app/**`,
`front/package.json`), the contracts (`contracts/http-contract.ts`), the PHP
routing and headers (`php/public/.htaccess`, `php/src/Deploy/HtaccessRenderer.php`)
and the route composition (`php/src/Composition/*`), on 2026-09-12 at
`74dbfbac`. A locally built, uncommitted `front/out/` export was grepped as a
secondary check; the committed sources are the authority. Every finding is a
**repository fact**.

**Acceptance criterion of ESZ-166: no analytics or marketing tracker is
introduced.** Result: none is present, and none is introduced.

## 5.1 Findings by category

| Category | Present? | What exactly |
|---|---|---|
| **Analytics, advertising, behavioural tracking, marketing cookies** | **No** | No dependency and no source reference to any analytics or marketing library (searched: gtag / google-analytics / googletagmanager / plausible / matomo / hotjar / segment / facebook / fbq / pixel / sentry / posthog / mixpanel / umami / clarity / `@vercel/analytics` / speed-insights — zero hits in `front/app` and `front/package.json`). Runtime dependencies are exactly `next`, `react`, `react-dom`, `zod` and the local `@eszter/contracts`. No third-party `<script>`, no `next/script`, no tag manager. |
| **Necessary admin authentication cookie** | **Yes — admin only** | One cookie, `__Host-eszter_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`; opaque id, server-side record authoritative, rotated on login, destroyed on logout (`contracts/http-contract.ts` `sessionCookie`; `php/src/Auth/SessionCookie.php`). It is set by `GET /api/auth/session` and `POST /api/auth/login`, which only the admin area (`front/app/admin/(protected)/layout.tsx` → `AdminSessionProvider`) calls. An anonymous session row + cookie may be created for an admin-page visitor before login (CSRF bootstrap); it is rate-limited and garbage-collected. This cookie is strictly necessary for the authenticated service the administrator explicitly requests; it is not a tracker and needs no consent. |
| **Cookies on the public site** (home, `/reservation`, `/mentions-legales`, `/confidentialite`) | **None set by the application** | The public routes (`/api/health`, `/api/content`, `/api/legal`, `/api/bookings*`) are composed without the session/CSRF collaborators (`php/src/Composition/BookingRoutes.php`: the three public booking endpoints receive `$public`, the admin ones `$admin` with `csrf`). The booking flow (`front/app/lib/booking-api.ts`) sends plain `fetch` requests carrying a privacy notice id, never a token or a cookie requirement. No public component reads `document.cookie`. |
| **Admin-only local browser storage** | **Yes — admin only, operational** | `localStorage` key `eszter:admin-content-draft:v1` (`front/app/lib/admin-draft-storage.ts`): the administrator's explicit local backup of an unsaved content draft, never authoritative, read only on an explicit restore. Editorial site content only — no customer data, no session id (`admin-api.ts` and `admin-session-provider.tsx` document that the session id and CSRF token are never written to `localStorage`). No `sessionStorage`, `indexedDB` or `sendBeacon` use anywhere in `front/app`. |
| **Public-site browser storage** | **None** | No `localStorage`/`sessionStorage` reference outside the admin modules listed above. |
| **Fonts** | **Self-hosted** | `next/font/google` (`Geist`, `Cormorant Garamond`) downloads the font files at **build time** and serves them from the export; the committed CSP is `font-src 'self'`, so a runtime request to Google's font hosts would be blocked by the browser. The local export contains no `fonts.googleapis.com` / `fonts.gstatic.com` reference. |
| **Outgoing links** | **Yes, plain links** | Instagram profile links in the default site content (`contracts/default-site-content.ts`) and wherever the editor places them. Plain `<a>` navigation, no embed, no widget, no pixel. |
| **Configurable external media** | **Possible, HTTPS-only, image requests only** | The editor may reference an external `https://` image (`docs/esz-104-external-media-and-csp.md`); CSP allows `img-src 'self' https:` and nothing else external. Loading such an image discloses the visitor's IP and user agent to that host — an editorial decision, documented there, not a tracker added by the application. Default content uses managed media. |
| **Same-origin iframe** | **Admin only** | The admin preview `<iframe src="/admin/preview">` is same-origin (`frame-src 'self'`, `frame-ancestors 'self'`). |
| **Inline scripts** | **Same-origin bootstrap only** | `front/app/page.tsx` embeds the published content JSON in a `<script>` element for PHP injection (`front/app/lib/public-bootstrap.ts`); CSP `script-src 'self' 'unsafe-inline'`. No external script origin is allowed by the CSP (`connect-src 'self'`). |

## 5.2 Committed headers (enforcement)

`php/public/.htaccess` (generated by `HtaccessRenderer`, proven identical to
the routing table by `DocumentRootRoutingTest::testTheCommittedHtaccessMatchesTheRoutingTable`):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' https:; font-src 'self';
  connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'self'; frame-src 'self'
Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(),
  encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(),
  magnetometer=(), microphone=(), midi=(), payment=(), usb=()
```

A tracker added later would have to be added to both the source and the CSP,
which makes its absence reviewable in a diff.

## 5.3 Conclusion and consequences

- No cookie banner is added by ESZ-166, and none is required by these findings:
  the only cookie is a strictly necessary authentication cookie on the admin
  surface, and no storage or tracker is used on the public site for any
  non-essential purpose. (This is not a claim that there are "no cookies
  whatsoever": the authenticated admin session uses one.)
- `/confidentialite` reads the frozen notice facts; it does not currently
  contain a cookie paragraph. Adding one is an editorial/legal decision for the
  operator (see `06-production-prerequisites.md`), not a code change this
  dossier requires.
- Any future addition of analytics, embedded social content, external
  scripts, or an SMS/e-mail provider script must re-run this review and
  revisit the consent question before deployment.
