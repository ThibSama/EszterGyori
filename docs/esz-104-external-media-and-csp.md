# ESZ-104 — External images are HTTPS-only, and the CSP says so

Status: accepted (V1 freeze).
Scope: the site-content contract (`mediaSourceSchema`), the admin media field,
and the production `Content-Security-Policy` rendered into the committed
`.htaccess`.

## Decision

External editorial images are **HTTPS-only**. The frozen V1 value set of a
media source is:

* a root-relative, same-origin public path (`/media/…`, any rooted path the
  public-path schema accepts) — allowed;
* a managed `/media/med_…` asset — allowed, subject to the ESZ-147 catalogue
  integrity guard on content writes;
* an external `https://` URL — allowed;
* an external `http://` URL — **invalid everywhere**;
* `null` — allowed (the site keeps its placeholder).

`data:` URIs are not editorial input: the contract rejects them as media
sources, and no rendering path in the export emits one, so they were removed
from `img-src` at the same time with that proof. (No `data:` URI occurs
anywhere in `front/out` or in the frontend sources; every match for the string
`data:` in the export is a code identifier, never a URI.)

The shared contract schema (`httpsUrlSchema` in `contracts/site-content.ts`)
is the single place where "external URL means HTTPS" is expressed. Instagram
links and external media sources both reuse it, so the protocol rule cannot
drift between the two surfaces; the previous inline `http(s)` branch in
`mediaSourceSchema` is gone. The PHP semantic validator implements the same
predicate (`Links::isMediaSource`, rule `media.sourceProtocol`), and the parity
corpus pins both directions with `media.sourceProtocol.httpRejected` and
`media.sourceProtocol.httpsAccepted`.

## Why HTTPS external media remains supported at all

The site is a CMS whose editors legitimately point an image at a photograph
that lives on another origin they do not control (a hosting account, a
portfolio, a partner site). Removing external media entirely would force every
such photograph through the managed library; keeping it is a V1 requirement of
the product, so the question is only how it is *constrained*.

## Why HTTP is forbidden

Two independent reasons, either of which would be enough:

1. **The browser would refuse it anyway.** The production policy is
   `img-src 'self' https:`. An `http:` image is not in the source list, so a
   contract-valid `http://` media source could never render on the public page
   — the contract would bless something the deployment blocks. Contract and
   deployment must describe the same world.
2. **It is a downgrade vector.** The public page is delivered over HTTPS
   (deployment redirect + HSTS at deploy time). An `http:` image on such a
   page is mixed content: an active attacker can replace the image bytes (and
   any request the image triggers) in transit. There is no editorial reason to
   accept that risk for a photograph.

## Why `https:` is scheme-wide, not a host allowlist

The CMS intentionally accepts **arbitrary HTTPS origins**: the editor's
external-URL field is free text, and the contract's URL branch does not
restrict the host. Any future host allowlist in the CSP would therefore be a
second policy that could silently disagree with the contract — the same drift
hazard the parity corpus exists to kill for schema validation. A scheme-wide
`https:` source *is* the contract, expressed in CSP syntax, and it changes in
one place when the contract does.

Host allowlists, `http:`, `*`, proxying, downloading or persisting remote
images remain out of scope for V1 and are explicitly not added.

## What the CSP change is

`img-src 'self' data:` → `img-src 'self' https:`

No other directive changes. The policy is rendered by
`HtaccessRenderer::contentSecurityPolicy()`, asserted directive-exact by
`SecurityHeadersTest` (including that every other directive is untouched), and
proved over Apache with the committed `.htaccess` by the `browser:public`
gate.

## External hosts receive image requests

Allowing an external HTTPS image means the visitor's browser sends a request
to that origin on every page load: the host sees the visitor's IP, `Referer`
(strict-origin-when-cross-origin sends the bare origin), and `User-Agent`.
That is inherent to external images and it is accepted knowingly — it is the
same exposure any embedded image has. What is *not* accepted is letting the
server itself fetch remote images (no proxy, no server-side download), so the
CMS never mediates, stores or retries those requests.

## Enforcement surface

* **Contract**: `mediaSourceSchema` reuses `httpsUrlSchema`; `http:` and other
  schemes rejected with issue path `/…/src` (parity cases
  `media.sourceProtocol.httpRejected` / `.httpsAccepted`).
* **Server**: every content write in V1 — draft save and publish — runs the
  document through the same structural + semantic validation envelope as any
  other issue: `400 VALIDATION_FAILED` with the issue path `/…/src`, no new
  error code.
* **Editor**: the media field's help, placeholder and preview logic come from
  one exported constant set and one predicate
  (`MEDIA_SOURCE_FIELD_MESSAGES`, `isPreviewableImageSource` in
  `front/app/lib/admin-media.ts`); an `http:` source is never described as
  acceptable and never previewed, so it never even becomes an image request.
* **Deployment**: `img-src 'self' https:` in the generated `.htaccess`,
  exercised by a real browser under Apache (`browser:public`, ESZ-104 proofs).
