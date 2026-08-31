# ESZ-001 — Runtime inventory (current → target)

Baseline for the Express → PHP migration. This document recorded what existed at
Package 0.1 and what the PHP target had to do with it.

> **Historical for everything it says about Express.** The migration it plans is
> **done for the public surface**: Package 1.1 (ESZ-010/011/012) built the PHP
> foundation, Package 1.2 (ESZ-013/014) implemented `GET /api/health` and
> `GET /api/content` and proved them against the full HTTP contract, and ESZ-015
> **deleted `API/`** along with its Dockerfile and the `api:*` gates. Every "current"
> column below that names Express, `API/src/…`, `API/Dockerfile` or a Node production
> runtime describes something that no longer exists in this repository.
>
> The **target** columns are still the specification, and the rows whose subject is
> not yet built (admin auth, sessions, media, SQL, deployment) are still open. Read
> `php/README.md` and `docs/content-architecture.md` for what actually runs.

Closed since it was written: 4.4 (locking), 4.8 (fail-fast on a broken store), the
`process.uptime()` row in §8, and §12's four open questions — all four are answered
below. Those rows carry their resolutions inline.

Companion documents:

- `docs/contract-freeze.md` — ESZ-002/ESZ-003, the frozen public HTTP surface and the
  language-neutral contract artifacts.
- `docs/backend-target-architecture.md` — the earlier Node/Docker direction. Historical.
- `docs/hetzner-target-architecture.md` — ESZ-004, the Hetzner production architecture
  that resolves several dispositions recorded here (notably 9.x and 10.3).
- `docs/v1-quality-gates.md` — ESZ-005, the validation policy.

## Legend

| Disposition | Meaning |
| --- | --- |
| **Port** | Same responsibility must exist in PHP, behaviour frozen by the contract. |
| **Replace** | Responsibility stays, mechanism changes (Node API → PHP/platform equivalent). |
| **Build-only** | Runs at build time; no PHP runtime counterpart. |
| **Static** | Becomes a static artifact rather than runtime behaviour. |
| **Remove** | Disappears; no counterpart. |
| **Stays on Node** | Deliberately remains outside PHP (the Next.js frontend). |

---

## 1. HTTP runtime and Express-specific behaviour

> **Historical "current" column.** `API/src/*` no longer exists. Every **Port** and
> **Replace** row here is implemented in `php/` and replayed by gate
> `php:http-contract`; the **Remove** rows were removed with the service.

| # | Responsibility | Current owner | Disposition | Target notes |
| --- | --- | --- | --- | --- |
| 1.1 | HTTP server, routing | `API/src/app.ts` (Express 5) | **Replace** | PHP-FPM/web server routing. Only `/api/health` and `/api/content` exist. |
| 1.2 | Method-not-allowed handling | `sendMethodNotAllowed`, `app.all(...)` | **Port** | 405 + `Allow: GET` + error envelope. Frozen: `health.post.methodNotAllowed`, `content.post.methodNotAllowed`, `content.put.methodNotAllowed`. |
| 1.3 | Catch-all 404 | `app.use(...)` terminal handler | **Port** | Unknown routes return the JSON 404 envelope, never an HTML server error page. |
| 1.4 | JSON body parsing + 64 KB limit | `express.json({ limit: "64kb" })` | **Port** | Malformed JSON → 400 `INVALID_JSON`. The limit is contract data (`requestBodyLimit`). |
| 1.5 | Centralised error handler | `errorHandler` in `app.ts` | **Port** | Mapping frozen: `SyntaxError`→400, `HttpError`→its status, `ZodError`→400 `INVALID_CONFIGURATION`, otherwise 500 `INTERNAL_ERROR`. |
| 1.6 | `x-powered-by` disabled | `app.disable("x-powered-by")` | **Port** | PHP must suppress `X-Powered-By` / `Server` version banners equivalently. |
| 1.7 | Express weak ETag on error bodies | Express default | **Remove** | Incidental. The contract only forbids a `"published-<n>"` ETag on errors; PHP need not reproduce the weak validator. |
| 1.8 | Graceful shutdown (SIGINT/SIGTERM, 5 s timeout) | `API/src/server.ts` | **Remove** | Per-request PHP processes have no long-lived socket to drain. Belongs to the process manager. |
| 1.9 | Listen on host/port, ephemeral-port testing | `startServer` | **Replace** | Owned by the web server, not application code. |

## 2. Request identity and observability

| # | Responsibility | Current owner | Disposition | Target notes |
| --- | --- | --- | --- | --- |
| 2.1 | Request id generation | `createRequestId` → `req_${randomUUID()}` | **Replace** | Node `crypto.randomUUID` → PHP UUID generation. Prefix `req_` is contract data. |
| 2.2 | Inbound request id validation | `isSafeRequestId`, `^[A-Za-z0-9._:-]{1,80}$` | **Port** | Untrusted values are replaced, never echoed. Header-injection guard; must not be relaxed. |
| 2.3 | `X-Request-Id` on every response | `requestIdMiddleware` | **Port** | Frozen invariant `requestId.presentOnEveryResponse`. |
| 2.4 | `error.requestId` mirrors the header | `createErrorBody` | **Port** | Asserted per-case in the contract suite. |
| 2.5 | Structured console logging | `console.info` / `console.error` | **Replace** | PHP logger. Log payloads are not contract; message content is free to change. |
| 2.6 | Storage-failure log without leaking detail | `routes/public-content.ts` | **Port** | The *response* must stay opaque (`errors.leakNothing`); the log may stay detailed. |

## 3. Public content loading

| # | Responsibility | Current owner | Disposition | Target notes |
| --- | --- | --- | --- | --- |
| 3.1 | `GET /api/content` handler | `handleGetPublicContent` | **Port** | Frozen end to end by `contracts/generated/http-contract.json`. |
| 3.2 | Response re-validation before send | `publishedContentEnvelopeV1Schema.parse` | **Port** | PHP validates against the generated schema **plus** `semantic-rules.json`. A validation failure must surface as 500 `STORAGE_FAILURE`, not a 200 with bad data. |
| 3.3 | ETag derivation | `createPublishedEtag(revision)` | **Port** | `"published-<revision>"`, revision as the only input. |
| 3.4 | `If-None-Match` handling | `ifNoneMatchIncludes` | **Port** | Comma-split, trimmed, `*` matches. 304 keeps ETag + Cache-Control and sends an empty body. |
| 3.5 | Cache headers | `setContentCacheHeaders` | **Port** | `public, max-age=0, must-revalidate`, on both 200 and 304. |
| 3.6 | Legacy `appearance` normalisation | `siteContentSchema` default | **Port** | Content without `appearance` stays valid, is served with `defaultSiteAppearance`, and the ETag does not change. |
| 3.7 | Opaque storage-failure mapping | `isStorageError` / `ZodError` branch | **Port** | Both storage and response-validation failures collapse to the same 500 `STORAGE_FAILURE`. |

## 4. Persistence

| # | Responsibility | Current owner | Disposition | Target notes |
| --- | --- | --- | --- | --- |
| 4.1 | JSON file store (`draft.json`, `published.json`) | `JsonContentStorage` | **Replace** | Storage engine is an open decision (files or SQL). The *envelope contract* is frozen either way. |
| 4.2 | Atomic write (temp file + `rename`) | `atomic-json-file.ts` | **Port** | Same durability requirement: no torn reads, no partial file visible to readers. |
| 4.3 | `fsync` before rename | `handle.sync()` | **Replace** | **Done in Package 1.1:** `fflush()` then `fsync()` before `chmod` and `rename()` (`php/src/Storage/AtomicJsonFile.php`). Bootstrap additionally refuses a temp directory on a different filesystem, since `rename()` is only atomic within one. |
| 4.4 | Serialised write queue (in-process) | `enqueueWrite` | **Replace** | An in-process promise chain does not survive a per-request PHP model. **Closed by Package 1.1:** advisory `flock()` on `data/locks/content.lock`, held for the whole read-modify-write (`php/src/Storage/FileLock.php`). Requires local storage — `flock` does not work over NFS. |
| 4.5 | Seed-on-first-boot from `defaultSiteContent` | `initialize()` | **Port** | Seeding must remain idempotent and must validate an existing file rather than overwrite it. |
| 4.6 | 1 MB max content file size | `MAX_CONTENT_FILE_BYTES` | **Port** | Denial-of-service guard. |
| 4.7 | Typed storage error codes | `storage-errors.ts` | **Port** | Internal taxonomy; only the collapsed `STORAGE_FAILURE` is public. |
| 4.8 | Validate storage before opening the port | `startServer` | **Replace** | No port to hold open. **Decided in Package 1.1: strict fail-fast.** A required file that is malformed, oversized, schema-incompatible or semantically invalid aborts the boot — per request, since PHP has no startup — and is never repaired or replaced. Reseeding from defaults would silently discard an editor's work and report success. |
| 4.9 | Draft read/write, publish | `readDraft` / `writeDraft` / `writePublished` | **Port** | Present in storage but reachable through no route today. Not part of the frozen public surface. |

## 5. Configuration and environment variables

> **Resolved by Package 2.1 (ESZ-020).** The `Port`/`Stays on Node` dispositions below
> are now history. `CONTENT_API_URL` was **removed**, not ported: PHP serves `/` and
> reads the content from disk, so the frontend has no API URL to know. Every `ADMIN_*`
> variable was removed with the auth code in §6. `front/.env.example` is gone — the
> frontend needs no environment at build time, and runtime configuration lives in
> `php/config/config.php`, which gained a `paths.public` key for the document root.

| Variable | Current owner | Disposition | Target notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `API/src/config.ts` (`development`/`test`/`production`) | **Remove** | Node-specific. Replace with a PHP environment flag if needed. |
| `HOST` | `API/src/config.ts`, default `127.0.0.1` | **Remove** | Web-server concern. |
| `PORT` | `API/src/config.ts`, default `4000` | **Remove** | Web-server concern. |
| `LOG_LEVEL` | `API/src/config.ts`, default `info` | **Replace** | Parsed but currently unused by any logger — no behaviour is lost. |
| `CONTENT_DATA_DIR` | `API/src/config.ts`, default `<API package>/data` | **Replace** | Only if the file backend is kept. Relative paths resolve against the package root today. |
| `CONTENT_API_URL` | `front/app/lib/server/public-content.ts` | **Port** | Must keep pointing at the full `/api/content` URL. Server-only; never `NEXT_PUBLIC_`. |
| `ADMIN_USERNAME` | `front/app/lib/auth/config.ts` | **Stays on Node** | Frontend admin session only. |
| `ADMIN_PASSWORD_HASH` | `front/app/lib/auth/config.ts` | **Stays on Node** | scrypt hash, see 6.2. |
| `ADMIN_SESSION_SECRET` | `front/app/lib/auth/config.ts` (≥32 bytes) | **Stays on Node** | HS256 signing key. |
| `ADMIN_SESSION_TTL_SECONDS` | `front/app/lib/auth/config.ts` (900–86400, default 28800) | **Stays on Node** | |

Fail-fast semantics are worth preserving: invalid configuration currently throws a
`ZodError` at startup and exits 1 rather than booting with defaults.

## 6. Admin authentication and session

> **Resolved by Package 2.1 (ESZ-020), and not in the way this table expected.** Every
> row below was **deleted rather than ported or kept**: `proxy.ts`, `password.ts`,
> `session-token.ts`, `session-cookie.ts`, `request-origin.ts` and `safe-redirect.ts` are
> gone, along with the two `/admin/auth/*` route handlers.
>
> The reason is 6.1's own note taken seriously: it was a frontend-only gate and
> explicitly not authorization. A static host cannot run it, and re-creating it in the
> browser would be a check the caller controls, guarding a page the caller already has.
> **`/admin` is currently unprotected.** Package 2.2 builds the real thing in PHP —
> `password_hash()`, an opaque server-side session, per-session CSRF — per
> `docs/hetzner-target-architecture.md` §6. Rows 6.2 and 6.3 describe the *old* scheme
> and are not a specification for it; the scrypt parameters and the JWT shape are
> deliberately not being reproduced.

Still true, and still open: this lives **entirely in the Next.js frontend**. The PHP
API has no authentication, and none of the `/api/admin/*` or `/api/auth/*` routes
exist — the contract suite asserts they return 404.

| # | Responsibility | Current owner | Disposition | Target notes |
| --- | --- | --- | --- | --- |
| 6.1 | Route protection for `/admin/*` | `front/proxy.ts` | **Stays on Node** | Frontend-only gate. Explicitly **not** authorization for any API route. |
| 6.2 | Password hashing (scrypt, N=16384, r=8, p=1, 64-byte key) | `front/app/lib/auth/password.ts` | **Port** *(if auth moves to PHP)* | Uses `node:crypto.scrypt` and `timingSafeEqual`. PHP must reproduce both the parameters and the constant-time comparison. |
| 6.3 | Session token (JWT HS256, `jose`) | `front/app/lib/auth/session-token.ts` | **Port** *(if auth moves)* | Issuer `eszter-frontend`, audience `eszter-admin`, subject/role `admin`, `jti`, `iat`, `exp`. |
| 6.4 | Session cookie | `session-cookie.ts` | **Stays on Node** | `eszter_admin_session`, HttpOnly, SameSite=Strict, path `/admin`, Secure in production. |
| 6.5 | Same-origin POST check | `request-origin.ts` | **Stays on Node** | Origin + `Sec-Fetch-Site`. Not a substitute for real CSRF tokens on a future API. |
| 6.6 | Redirect sanitisation | `safe-redirect.ts` | **Stays on Node** | Open-redirect guard. |
| 6.7 | Password-hash generation CLI | `front/scripts/generate-admin-password-hash.mjs` | **Build-only** | Operator tool, never a runtime path. |

**Migration constraint:** if API authentication is introduced, it must be an
independent backend mechanism. The frontend session must never be treated as
authorization for a PHP endpoint.

## 7. Node-specific APIs in use

> **Historical for the `API/` rows.** Every location under `API/src/` is gone; the
> disposition column records what PHP did instead. The `front/` rows are current.

| API | Location | Disposition |
| --- | --- | --- |
| `node:crypto.randomUUID` | `request-id.ts`, `session-token.ts` | **Replace** |
| `node:crypto.scrypt`, `timingSafeEqual`, `randomBytes` | `auth/password.ts` | **Port** (see 6.2) |
| `node:fs/promises` (`open`, `rename`, `mkdir`, `readFile`, `stat`, `access`, `rm`) | `storage/*` | **Replace** |
| `node:path`, `node:url` (`fileURLToPath`) | `config.ts`, `storage` | **Replace** |
| `node:http` `Server` | `server.ts` | **Remove** |
| `process.uptime()` | `app.ts` health payload | **Removed, done.** ESZ-013 dropped `uptimeSeconds` from the contract rather than substituting a value that cannot be true, and removed the `health.uptimeMonotonic` invariant with it. See `docs/contract-freeze.md`, Part 4. |
| `process.env` | config modules | **Replace** |
| `process.once("SIGINT"/"SIGTERM")`, `process.exit` | `server.ts`, `index.ts` | **Remove** |
| `Buffer`, `TextEncoder` | auth modules | **Replace** |
| `AbortController` + `fetch` timeout | `front/.../public-content.ts` | **Stays on Node** |
| `structuredClone` | `contracts/parity-runtime.ts` | **Build-only** (test tooling) |

## 8. Build-time vs production-runtime Node

| Concern | Today | After migration |
| --- | --- | --- |
| `contracts/` TypeScript → `dist/` | `tsc`, run in CI/Docker/Vercel install | **Build-only.** PHP consumes `contracts/generated/*.json`, never `dist/`. |
| Contract artifact generation | `npm run generate` in `contracts/` | **Build-only.** Output is committed; `verify:generated` fails on drift. |
| API bundling | `esbuild` → `API/dist/index.js` | **Removed, done** with the Express service (ESZ-015). |
| Next.js build | `next build` | **Stays on Node.** Frontend build remains a Node toolchain. |
| Next.js production server | `next start` / Vercel | **Stays on Node.** |
| Test runners (`node:test`, `tsx`) | `contracts/`, `front/` (`API/` retired) | **Build-only.** The parity corpus is re-run from PHP without Node, and PHPUnit is the runner for the HTTP contract. |

**Node is required at build time for the frontend and for regenerating contract
artifacts. Node must not be required by the PHP service at runtime.**

## 9. Docker and Vercel assumptions

> **Historical.** Rows 9.1–9.7 describe `API/Dockerfile`, which was deleted in
> ESZ-015 together with `.dockerignore`. There is no image, no `/data` volume and no
> container runtime in this repository. The target host is Hetzner shared hosting
> (`docs/hetzner-target-architecture.md`), where the web server — not Docker —
> provides the non-root user, the process model and the health probe. Rows 9.8–9.9
> concern the frontend and are still binding.

| # | Assumption | Where | Disposition |
| --- | --- | --- | --- |
| 9.1 | Multi-stage build from the repo root (contracts → API → runtime) | `API/Dockerfile` | **Replace** | 
| 9.2 | `node:20-bookworm-slim` base | `API/Dockerfile` | **Replace** with a PHP base image. |
| 9.3 | Non-root `node` user | `API/Dockerfile` | **Port** — keep a non-root runtime user. |
| 9.4 | `/data` declared as `VOLUME`, owned by the runtime user | `API/Dockerfile` | **Port** if the file backend is kept. |
| 9.5 | Docker `HEALTHCHECK` on `GET /api/health` | `API/Dockerfile` | **Port** — the endpoint is frozen precisely so the check survives. |
| 9.6 | `STOPSIGNAL SIGTERM` paired with graceful shutdown | `API/Dockerfile` | **Remove** with 1.8. |
| 9.7 | Production env baked into the image (`HOST`, `PORT`, `CONTENT_DATA_DIR`) | `API/Dockerfile` | **Replace** per 5. |
| 9.8 | Frontend deploys to Vercel; `contracts` installed via `file:../contracts` | `front/package.json`, `contracts/README.md` | **Stays on Node.** The `postinstall`/`predev` contract build must keep working. |
| 9.9 | Contracts must not build from an npm `prepare` script | `contracts/README.md` | **Stays on Node** — Vercel-specific constraint, still binding. |
| 9.10 | No reverse proxy, no internal HTTPS, no backup, no multi-instance story | `docs/backend-target-architecture.md` | **Open** — unchanged by this package. |

## 10. Frontend consumption of the API

> **Resolved by Package 2.1 (ESZ-021).** Rows 10.1–10.3 no longer exist: there is no
> server-side fetch, no timeout and no ISR, because there is no Node server. `/` is
> served by PHP, which injects the published content into the exported HTML; ISR is
> replaced by `must-revalidate` plus the `published-<revision>` ETag, which closes
> disposition 10.3 as `docs/hetzner-target-architecture.md` §5 said it would.
>
> Rows 10.4 and 10.5 **survived and moved**, which is the interesting part. The frontend
> still refuses to trust what it is handed and still degrades to `defaultSiteContent` —
> only now the untrusted input is a text substitution performed by another process
> rather than an HTTP response, and the check lives in
> `front/app/lib/public-bootstrap.ts`. The principle was the durable part; the transport
> was not.

| # | Responsibility | Current owner | Disposition |
| --- | --- | --- | --- |
| 10.1 | Server-side fetch of `/api/content` | `front/app/lib/server/public-content.ts` | **Stays on Node.** The browser never sees the API URL. |
| 10.2 | 3 s timeout via `AbortController` | same | **Stays on Node.** PHP must respond well inside it. |
| 10.3 | 60 s ISR revalidation | same (`next.revalidate`) | **Stays on Node.** Interacts with the ETag: a revision bump is what makes new content visible. |
| 10.4 | Typed fallback to `defaultSiteContent` | same, 8 `FallbackReason` codes | **Stays on Node.** Any API failure degrades to default content rather than an error page. |
| 10.5 | Response validated before use | `publishedContentEnvelopeV1Schema.safeParse` | **Stays on Node.** The frontend does not trust the API; a PHP response that drifts from the contract silently falls back to defaults. |

## 11. Explicitly out of scope for Package 0.1

Not started, by instruction: ESZ-004/005, PHP implementation, static conversion,
SQL, API-side auth/CSRF, CMS write endpoints, booking, notifications, deployment.

*Historical:* this records the boundary of Package 0.1. ESZ-004 and ESZ-005 were
delivered in Package 0.2 as `docs/hetzner-target-architecture.md` and
`docs/v1-quality-gates.md`. Everything else in this list is still not started.

## 12. Open questions carried forward — all four are now answered

1. **Write concurrency (4.4)** — *Answered (ESZ-012, refined ESZ-014).* Advisory
   `flock()` on `data/locks/content.lock`. Reads take `LOCK_SH`; the exclusive lock
   is held across a whole read-modify-write and for seeding, which re-checks under
   it. Still true that no write endpoint exists yet.
2. **Fail-fast on broken storage (4.8)** — *Answered (ESZ-012, refined ESZ-013).*
   A malformed, oversized or invalid required document is never repaired, replaced or
   bypassed. Since ESZ-013 the failure lands on the request that asked for it — a 500
   `STORAGE_FAILURE` on `GET /api/content` — rather than on every path, so
   `/api/health` stays independent of content.
3. **Storage engine (4.1)** — *Answered (ESZ-004, implemented ESZ-012).* Editorial
   content stays in JSON files; SQL is reserved for operational state. The envelope
   contract holds either way, as predicted.
4. **`uptimeSeconds` semantics (7)** — *Answered (ESZ-013).* The field was **removed
   from the contract**. Each PHP request is its own process, so no honest value
   exists; the `health.uptimeMonotonic` invariant went with it. See
   `docs/contract-freeze.md`, Part 4.
