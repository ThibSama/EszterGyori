# Package 2.1 — ESZ-020/021/022

Removing the last production Node runtime, and keeping published content dynamic
anyway.

Companion documents:

- `docs/hetzner-target-architecture.md` — ESZ-004, §5 (injection), §6 (admin), §12
  (routing). This package builds §5 and §12, and half of §6.
- `docs/contract-freeze.md` — ESZ-002/003, the frozen surface `/` has now joined.
- `docs/v1-quality-gates.md` — ESZ-005, where `front:export`, `php:public-page` and
  `php:routing` are declared.

---

## 1. The problem

The frontend was a Next.js app with a Node server behind it: ISR on `/`, middleware
gating `/admin/*`, two route handlers doing password verification and JWT signing.
Hetzner webhosting runs Apache and PHP-FPM and **no Node, ever**.

Deleting the server is easy. The hard part is the consequence: a static export bakes
content at *build* time, and the entire point of the CMS is that Eszter changes content
**without** a rebuild — on a host with no Node to rebuild with.

## 2. What was removed

| Removed | Why it could not come along |
| --- | --- |
| `front/proxy.ts` | Middleware runs on a server. There is none. |
| `front/app/admin/auth/{login,logout}/route.ts` | Route handlers are server endpoints. |
| `front/app/lib/auth/*` | `node:crypto` scrypt, `jose` JWT signing, `next/headers` cookies — all request-time server code. |
| `front/app/lib/server/public-content.ts` | Server-side fetch of `/api/content`, with `next.revalidate`. Replaced by §4. |
| `front/scripts/generate-admin-password-hash.mjs` | Generated hashes for a scheme PHP will not use; 2.2 uses `password_hash()`. |
| `jose`, `server-only` dependencies | Nothing imports them any more. |
| `next start` script | Boots a Node server. |
| `front/.env.example` | `CONTENT_API_URL` and `ADMIN_*` have no target counterpart; configuration moved to `php/config/` (§9 of ESZ-004). |

`output: "export"` is what keeps them gone. Under that flag every one of the above is a
**build error**, not a runtime surprise — which is why the removal is enforced rather
than merely done.

## 3. What `/admin` is now, and what it is not

A static shell. The layout no longer calls `requireAdminSession()`; the login page is a
notice, not a form.

**It is not access-controlled, and nothing in this package pretends otherwise.** The
middleware was deleted rather than reimplemented in the browser, because a check the
caller controls, guarding a page the caller already has, is not a security boundary —
it is a decoration that makes the gap harder to see. Package 2.2 puts enforcement in
PHP on every `/api/admin/*` call, which is the only place it can live.

Nothing leaks in the meantime: the shell has no server API to read from, holds no
secrets, and drafts stay in the editor's own browser. The risk arrives with 2.2's
endpoints, not before. The generated `.htaccess` carries a commented-out Basic auth
block for the case where the site is deployed before then.

## 4. Content injection (ESZ-021)

```text
next build ──▶ out/index.html
                 ├─ <style  id="__ESZTER_APPEARANCE__">  :root{--site-*}  ← defaults
                 └─ <script id="__ESZTER_CONTENT__">     {envelope}       ← defaults

GET /  ──▶ api/index.php ──▶ PublicPageEndpoint
             ├─ read + re-validate data/content/published.json
             ├─ PublicPageBootstrap rewrites those two elements
             ├─ ETag: "published-<revision>"   (the same EntityTag the API uses)
             └─ If-None-Match ──▶ 304, empty body
```

Properties, and why each is a property rather than an accident:

- **Publishing needs no rebuild.** The file on disk never changes; only the stored
  revision does. Asserted by
  `testAPublishChangesThePageWithoutRebuildingTheFrontend`.
- **One cache identity.** `/` and `/api/content` mint the same ETag from the same
  `EntityTag` instance, so one publish invalidates both. Asserted by
  `testThePageAndTheContentEndpointShareOneCacheIdentity`.
- **The same document reaches both surfaces.** Injection is a text substitution, not a
  second serializer. Asserted by `testTheSameContentReachesThePageAndTheApi`.
- **It degrades, it does not fail.** Unreadable or invalid content serves the exported
  defaults with 200 and **no** published ETag. The API answers 500 for the same
  condition; the difference is deliberate, and the reasoning is on
  `publicPageFallbackOutcome`.
- **Editorial copy cannot escape the element.** `<`, `>` and `&` are encoded by
  `json_encode`'s `JSON_HEX_*` flags, which act inside string values and leave JSON's
  delimiters alone.

### The one thing this does not achieve

The baked HTML carries the **canonical defaults**, not the published copy — a static
export can only bake what existed at build time. Crawlers and the first paint therefore
see real, indexable French copy, which is what ESZ-004 §5 required; but where published
copy has diverged from the last build, React reconciles the difference just after
hydration, via `useSyncExternalStore`.

Colours are exempt from that: they arrive as the PHP-injected `:root` block in `<head>`
and are correct before React runs, which is why `SitePreview` takes an
`appearanceSource` prop and the public page passes `"document"`.

## 5. Routing (ESZ-022)

The rules are declared once, in `php/src/Deploy/DocumentRootRouting.php`, rendered into
`php/public/.htaccess` by `php/bin/generate-htaccess.php`, and drift-checked by
`php:routing`. `.htaccess` is otherwise the one load-bearing part of the system with no
tests — it cannot be unit-tested, it only misbehaves on the host, and its failures are
the confusing kind.

| # | Path | Resolves to |
| --- | --- | --- |
| 1 | `/api`, `/api/*` | the PHP front controller — **first**, so nothing can shadow an API path and answer HTML where a JSON envelope is frozen |
| 2 | `/index.html` | 301 to `/`, so the uninjected build output is never served under its own name |
| 3 | an existing file or directory | served directly (`_next/`, `media/`, icons, `robots.txt`) |
| 4 | `/reservation`, `/reservation/*` | the 404 document — reserved, no booking UI |
| 5 | `/admin/<page>` with an exported file | `admin/<page>.html` |
| 6 | any other `/admin/*` | `admin.html`, so a refresh on a deep link loads the shell |
| 7 | `/` | the PHP front controller (§4) |
| 8 | anything else | the 404 document |

Three details that are easy to get wrong and expensive to debug on a host:

- **`DirectoryIndex disabled`** is load-bearing. If Apache could resolve `/` to
  `index.html` itself, it would serve the build output — correct-looking, permanently
  stale, and very hard to notice.
- **Rule 3 excludes the root explicitly.** `%{REQUEST_FILENAME}` for `/` is the document
  root, which *is* a directory, so without the exclusion the rule would match and end
  the chain — and with the index disabled, `/` would 403.
- **`trailingSlash: false`** in `next.config.ts` must match these rules. The export
  emits `admin/login.html`, not `admin/login/index.html`. Disagreement here produces
  redirect loops that appear only in production.

`<Directory>` and `php_flag` are absent by necessity, not by preference: the first is
illegal in `.htaccess` and makes Apache refuse the directory outright, the second needs
mod_php and is a 500 under PHP-FPM. `PHP-under-media/` is denied from a second
`.htaccess` inside `media/`, with `Require all denied`.

## 6. Contract changes

`/` moved from "not ours" to a contracted endpoint, which is why this package touched
`contracts/` at all:

- New endpoint `/` with methods `["GET", "HEAD"]` and statuses `[200, 304, 400, 405]` —
  no 500, because the page degrades instead.
- New body matcher `publicPageHtml`, and a `pageContent` expectation naming which
  document a case must render.
- Seven new cases (`page.*`), four new invariants.
- `publicPage.bootstrap` in the generated artifact, carrying the element ids and the
  ordered CSS custom-property list PHP reads.
- **`unknown.get.rootNotFound` and its PHP exemption are gone.** The exemption said `/`
  was not this service's to answer; that stopped being true. The exemption set is now
  empty and a test asserts it stays empty.

`HEAD` is accepted on `/` and still 405s on the JSON surface. That difference is
deliberate: `/` is a document crawlers and uptime monitors probe with HEAD, and a 405
there is a self-inflicted wound; nobody has ever cared about `HEAD /api/health`.

## 7. What Package 2.1 does not prove

- **Apache applying the generated rules.** `php:routing` proves the table, and that the
  committed file matches it using only legal directives. It cannot prove `mod_rewrite`
  is enabled or `AllowOverride` permits them. That is `smoke:http`, and it needs a host.
- **Anything about authorisation.** See §3.
- **Deployment.** No host, no TLS, no automation.
