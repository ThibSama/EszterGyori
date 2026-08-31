# ESZ-002 / ESZ-003 — Contract freeze and TS/PHP contract strategy

This document describes the frozen public HTTP surface and the mechanism that lets
TypeScript keep validating with Zod while the PHP backend consumes a
language-neutral contract without running Node.

Since Package 1.2 (ESZ-015), **PHP is the only implementation of this surface**. The
Express reference service that co-implemented it from ESZ-002 has been retired; see
Part 5.

Companion documents: `docs/runtime-inventory.md` (ESZ-001),
`docs/hetzner-target-architecture.md` (ESZ-004) and `docs/v1-quality-gates.md` (ESZ-005).

---

## Part 1 — ESZ-002: the frozen surface

### What is frozen

The public read-only surface:

- `GET /api/health`
- `GET /api/content`
- `GET | HEAD /` — the public page (added by ESZ-021)

and, since ESZ-025/026, the authenticated surface:

- `GET /api/auth/session` — reports authentication state and issues the CSRF token
- `POST /api/auth/login`
- `POST /api/auth/logout`

and, since Package 3.1 (ESZ-030/031/032/033), the authenticated content surface:

- `GET /api/admin/content/draft` — read the server draft
- `PUT /api/admin/content/draft` — replace it, with an `expectedRevision` precondition
- `POST /api/admin/content/publish` — publish the stored draft
- `POST /api/admin/content/reset` — rebuild the draft from published content

Everything else returns a structured JSON 404. `/api/admin/media` is the only
unimplemented route left, and that 404 is itself frozen, so accidentally shipping a
half-built admin route is a test failure rather than a surprise.

Package 3.1 also added `REVISION_CONFLICT` to the error codes and one response header,
`x-content-revision`. Both exist to keep the error envelope closed: a caller that loses
an optimistic-concurrency race needs to know which revision it lost to, and the
alternatives were widening the frozen envelope for one endpoint family or making the
client issue a second request to find out.

The auth routes entered this document **before** they existed in PHP, which is the
ordering `docs/hetzner-target-architecture.md` §6 requires and the reason the contract
is a source of truth rather than a description written afterwards. They brought an
`auth` block with them — the session-cookie attributes, the CSRF lifecycle, the
login-failure outcome and the identity normalisation rules — and PHP reads its security
posture out of that block instead of restating it, exactly as it reads the injection
element ids for `/`.

Source of truth: `contracts/http-contract.ts`.
Generated artifact: `contracts/generated/http-contract.json`.
Executed by: `php/tests/Http/HttpContractConformanceTest.php` (gate `php:http-contract`).

The conformance suite reads the **generated JSON**, not the TypeScript module. That
is deliberate: it proves the artifact the implementation consumes is faithful to the
running service, rather than a description that can quietly drift.

### Methods and statuses

| Endpoint | Methods | Statuses |
| --- | --- | --- |
| `/api/health` | `GET` | 200, 400, 405 |
| `/api/content` | `GET` | 200, 304, 400, 405, 500 |
| `/` | `GET`, `HEAD` | 200, 304, 400, 405 |
| `/api/auth/session` | `GET` | 200, 400, 405 |
| `/api/auth/login` | `POST` | 200, 400, 401, 403, 405 |
| `/api/auth/logout` | `POST` | 204, 400, 401, 403, 405 |
| anything else | any | 404 |

- Non-allowed method on a known path → **405** with `Allow`, never 404.
- Unknown path → **404** with the error envelope, never an HTML error page.
- Malformed JSON body → **400** `INVALID_JSON`, decided before method handling.
- Request bodies are capped at **64 kB**. Over the cap → **400** `INVALID_JSON`,
  enforced before routing and regardless of `Content-Type`, so an oversized body is
  a 400 even on a path that would otherwise be a 404 or a 405 (Package 1.2).
- The status lists above describe a service that started. A failure *before* routing
  answers **500** with the frozen envelope on any path, including `/api/health`; see
  "Bootstrap failure" below.
- `GET /api/auth/session` has no **401**: it reports authentication state rather than
  requiring it, which is what lets a caller obtain a CSRF token before it has anything
  else. `POST /api/auth/login` has no 404 for an unknown address — that is a **401**,
  identical to a wrong password and to a disabled account, because any difference
  between the three is an account enumeration oracle.
- On `/api/auth/logout`, authentication is resolved **before** CSRF: a caller with
  neither gets 401, not 403. Answering 403 first would tell an unauthenticated caller
  that its token was the problem, which implies a session it does not have.

### Error envelope

Every non-2xx JSON body is exactly:

```json
{ "error": { "code": "...", "message": "...", "requestId": "..." } }
```

The object is closed — no extra keys, at either level. Permitted codes:

`NOT_FOUND`, `METHOD_NOT_ALLOWED`, `INVALID_JSON`, `VALIDATION_FAILED`,
`INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `CSRF_TOKEN_INVALID`,
`INVALID_CONFIGURATION`, `STORAGE_FAILURE`, `INTERNAL_ERROR`.

The four added by ESZ-025/026 each name a distinct thing the caller can fix, which is
the only reason to add a code at all:

- `VALIDATION_FAILED` (400) — the body parsed as JSON but is not this request's shape.
  Distinct from `INVALID_JSON`, which means the bytes were not JSON.
- `INVALID_CREDENTIALS` (401) — the single login failure. Unknown address, wrong
  password and disabled account are indistinguishable by design.
- `UNAUTHENTICATED` (401) — no live session on a route that requires one.
- `CSRF_TOKEN_INVALID` (403) — missing, empty, malformed or non-matching token, all
  reported identically.

The French user-facing messages are part of the contract (`apiErrorMessages`) so the
frontend and a PHP implementation cannot diverge on copy.

### Request ids

- Header `X-Request-Id`, present on **every** response including 304 and 500.
- An inbound value is echoed **only** if it matches `^[A-Za-z0-9._:-]{1,80}$`;
  otherwise it is replaced by a generated `req_<uuid>`. This is a header-injection
  guard and must not be relaxed.
- `error.requestId` always repeats the response header.

### Schema and revision semantics

- `schemaVersion` is the literal `1` (`SITE_CONTENT_SCHEMA_VERSION`), echoed by
  `/api/health` as `contentSchemaVersion`.
- `revision` is a non-negative integer. It is the **only** input to the ETag.
- A content change without a revision bump is invisible to caches. Any future write
  path must increment the revision, or clients will serve stale content indefinitely.

### ETag, If-None-Match and caching

- ETag format: `"published-<revision>"` (strong, quoted).
- `Cache-Control: public, max-age=0, must-revalidate` on **both** 200 and 304.
- `If-None-Match` is split on commas and trimmed; `*` always matches; any member
  matching the current ETag yields 304.
- A 304 carries ETag and Cache-Control and an **empty** body.
- A malformed `If-None-Match` is ignored and yields a normal 200.
- Error responses must never carry a `"published-<n>"` ETag. A framework that
  attaches its own weak validator to an error body is tolerated; what the contract
  forbids is a *published* validator on a response that is not the published
  document.

### Storage failures

Both a storage error and a response that fails schema validation collapse to the
**same** opaque 500 `STORAGE_FAILURE`. The response body must not contain filesystem
paths, storage file names, stack frames or schema internals — asserted by the
`errors.leakNothing` invariant. Detailed diagnostics stay in the server log.

The service re-validates the published envelope **before** sending it. Serving
structurally valid but semantically wrong content is treated as a failure, not a
success.

### Health reads nothing

`GET /api/health` touches no file, takes no lock and never asks storage a question
(invariant `health.doesNotDependOnContentStorage`). Health answers "can this service
respond"; folding "is the published content valid" into it would make an editor's bad
publish look like an outage to every monitor watching the host. Content problems
surface on `/api/content`, as the 500 above.

This is also what keeps `/api/health`'s frozen statuses honest: 200, 400, 405, no 500.

### Bootstrap failure

Frozen in Package 1.2, because the target runtime made it observable. Node booted once
at `listen()`, so a failed boot meant no server and no response at all. PHP has no
startup — configuration loading, contract-artifact digest verification and routing all
happen inside the request — so a boot failure is something a client receives.

A failure before the request can be routed answers **500** on any path, including
`/api/health`, with:

- `INVALID_CONFIGURATION` for unusable configuration or artifacts that are missing or
  fail their manifest digest;
- `STORAGE_FAILURE` when content storage could not be initialised;
- `INTERNAL_ERROR` for anything else.

The body is the frozen envelope — never an HTML error page or a stack trace — carries
`X-Request-Id` under the normal trusted-inbound rules, leaks no path or schema
internal, and carries no published ETag.

It is stated here rather than folded into `/api/health`'s status list on purpose. That
list describes a service that started; this describes one that did not, and treating
it as a status of health would suggest health has a failure mode of its own.

### Frontend fallback

`front/app/lib/server/public-content.ts` never trusts the API:

- server-side fetch only, 3 s `AbortController` timeout, 60 s ISR revalidation;
- the response is re-validated with `publishedContentEnvelopeV1Schema`;
- any of eight typed `FallbackReason` conditions degrades to `defaultSiteContent`
  rather than erroring the page.

A PHP response that drifts from the contract therefore fails **silently** into default
content. That is exactly why the corpus below exists.

### What is deliberately not golden-tested

Timestamps and generated request ids are asserted by **matcher**, never by recorded
literal value:

| Value | Assertion |
| --- | --- |
| `timestamp` | parses and round-trips through `Date#toISOString` |
| generated `X-Request-Id` | matches the `req_` prefix, and differs from a rejected inbound value |
| echoed `X-Request-Id` | equals the inbound value exactly |

`uptimeSeconds` was in this table until Package 1.2, when it left the contract
entirely. See Part 4, "`uptimeSeconds` left `GET /api/health`".

---

## Part 2 — ESZ-003: TS/PHP contract strategy

### The problem

The risk is two hand-maintained schemas drifting apart: Zod in TypeScript, and
something else in PHP. Whoever edits one and forgets the other ships a bug that only
appears in production, and — given the frontend fallback above — appears as content
silently reverting to defaults.

### Why JSON Schema alone is not enough

`z.toJSONSchema` faithfully carries structure: object shapes, `additionalProperties:
false`, enums, `const`, string `pattern`, array `minItems`/`maxItems`.

It silently drops **every** `.refine`, `.superRefine` and `.transform` — which is where
this project's real invariants live:

- fixed technical ids (`hero-placeholder`, `discover-services`, …);
- positional ordering of navigation links, services, process steps, gallery items;
- WCAG contrast floors between palette colours;
- ISO-8601 round-trip exactness on timestamps;
- `mailto:` and Instagram-host URL restrictions;
- media source protocol restriction (`javascript:`, `data:`, `//host` rejected);
- hex uppercase normalisation and `appearance` default injection.

A PHP service validating only against JSON Schema would accept a document that Zod
rejects. So JSON Schema is used for what it is good at, and **the rest is covered by an
executable parity corpus**. Nothing is weakened; the lost semantics are re-stated, not
dropped.

### The mechanism

Three committed, machine-readable artifacts under `contracts/generated/`:

| Artifact | Role |
| --- | --- |
| `*.schema.json` | JSON Schema 2020-12, structural layer. Each carries an `x-eszter-warning` stating that passing it is necessary but **not** sufficient. |
| `semantic-rules.json` | Every rule JSON Schema cannot express: where it lives in the Zod source, why it is unrepresentable, and which parity cases prove it. |
| `parity-corpus.json` | The executable acceptance suite. |
| `http-contract.json` | The ESZ-002 freeze, as data. |
| `manifest.json` | Index plus SHA-256 digests of all of the above. |

Input and output schemas are emitted separately, because they genuinely differ:
`appearance` is optional on input and always present on output.

### The parity corpus format

Each case is a **base document plus a JSON Pointer patch**, rather than a full inlined
document. This keeps the corpus small and makes each case state exactly one thing.

```json
{
  "id": "links.instagramHttpsHost.httpRejected",
  "rule": "links.instagramHttpsHost",
  "expect": "invalid",
  "target": "siteContent",
  "patch": [{ "op": "replace", "path": "/contact/instagramCta/href", "value": "http://..." }],
  "expectedIssuePaths": ["/contact/instagramCta/href"]
}
```

A consumer needs only three things, all pure data handling:

1. JSON Pointer resolution (RFC 6901);
2. three patch operations — `replace`, `add`, `remove` (an RFC 6902 subset);
3. a mapping from its own validation errors back to JSON Pointer paths.

`valid` cases may additionally declare `expectedNormalization`, so normalising
behaviour (hex uppercasing, `appearance` defaulting) is verified rather than assumed.
`contracts/parity-runtime.ts` is the reference implementation of the runner.

### Drift prevention

Four mechanisms, all failing tests rather than review conventions:

1. **Regeneration check** — `tests/generated-artifacts.test.ts` re-derives every
   artifact and byte-compares it to what is committed. Editing Zod without running
   `npm run generate` fails.
2. **Digest check** — `manifest.json` digests must match the files on disk.
3. **Coverage check** — every declared semantic rule must have at least one parity
   case, and (except for the two normalisation rules) at least one *rejecting* case.
4. **Refinement census** — `tests/parity-coverage.test.ts` counts `.refine`,
   `.superRefine` and `.transform` occurrences in the schema sources against a frozen
   tally. Adding a refinement without declaring its semantics fails with a message
   saying what to do.

### Build-order invariant

**Nothing under `contracts/generated/` may be imported by the top-level contract
sources.** These sources are the *input* to the generator, so importing its output
would make regeneration depend on the last generation. (Until ESZ-015 the rule was
also enforced mechanically, because `API/Dockerfile` copied `contracts/*.ts` only;
that image is gone, the reason is not.) Generation is a build-time step whose output
is committed, and PHP reads the committed JSON — never `contracts/dist/`.

### Commands

```bash
cd contracts
npm run generate          # regenerate artifacts after changing any Zod schema
npm run verify:generated  # fail if the committed artifacts are stale
npm run typecheck         # package sources
npm run typecheck:tools   # scripts/ and tests/
npm test                  # parity corpus + coverage + drift
npm run build             # emit dist/ for front

cd ../php
composer run test         # parity-corpus replay + the executable HTTP contract
composer run stan         # PHPStan (pinned) + PSR-12

cd ..
npm run validate          # every gate, in policy order (docs/v1-quality-gates.md)
```

### What a PHP implementation must do

1. Validate structure against the generated JSON Schema documents.
2. Additionally enforce **every** rule in `semantic-rules.json`.
3. Prove it by replaying `parity-corpus.json` — same accept/reject outcome, same issue
   paths — and `http-contract.json` against its own HTTP layer.
4. Never re-derive a schema by hand from the TypeScript sources.

Note that a few JSON Schema `pattern` values are ECMA-262 regexes (for example the
public asset path pattern uses a `(?!\/)` lookahead). PCRE accepts these, but a
consumer using a stricter regex dialect must confirm equivalence rather than assume it.

### Patterns carry range when range is structural

A `pattern` that only checks a *shape* pushes the real restriction into the semantic
half, and then the same refusal is written twice in two dialects. Where the set of legal
values is finite and expressible as a regex, the pattern spells it out.

The worked example is civil time. `BOOKING_LOCAL_TIME_PATTERN` was `^\d{2}:\d{2}$`,
which accepted `25:00` and `09:60`: both satisfied Zod, both satisfied the generated
JSON Schema, both satisfied PHP's `StructuralValidator`, and both died in
`AvailabilityWindow` — so `HH:MM` on the wire meant "two digits, a colon, two digits"
and the type was weaker than the value it named. It is now
`^([01][0-9]|2[0-3]):[0-5][0-9]$`, which accepts exactly `00:00`–`23:59`.

This narrowed nothing that was ever valid; every previously accepted real time is
unchanged on the wire. It also removed nothing from the domain. The range is the only
thing a regex can decide; whether a window increases, whether a wall time exists on a
given date, and which side of an autumn fold it falls on are still `BookingTimePolicy`'s
to answer, and `AvailabilityWindow` still re-checks the range itself rather than
trusting that a caller went through the schema.

The rule generalises: put a constraint in the pattern when the pattern can express it
completely, and leave the semantic layer the constraints that need a calendar, a
timezone database, or the rest of the document.

---

## Part 3 — consumption status

`php/` is the **only** implementation of this contract. It satisfies all four
obligations as of Package 1.2 (ESZ-013 / ESZ-014 / ESZ-015). See `php/README.md`
for the mechanism; the short version:

| Obligation | State | Evidence |
| --- | --- | --- |
| Structural validation from `*.schema.json` | Done | `php/src/Contract/StructuralValidator.php` |
| Every `semantic-rules.json` rule enforced | Done | `php/src/Contract/SemanticRuleValidator.php`, asserted equal in both directions by `SemanticRuleCoverageTest` |
| `parity-corpus.json` replayed, same outcomes and issue paths | Done, 39/39 | `php/tests/Contract/ParityCorpusTest.php`, gate `php:parity-corpus` |
| `http-contract.json` replayed against the PHP HTTP layer | Done, **every case, no exemptions** | `php/tests/Http/HttpContractConformanceTest.php`, gate `php:http-contract` |
| Nothing re-derived by hand | Holds | No schema is written in PHP; artifacts are digest-verified against `manifest.json` on load. |

The conformance suite drives the real `Kernel`, not a stub. The two cases the
filesystem cannot stage honestly — `storage: failure` and `storage: malformed` —
are replayed through an injected `PublishedContentReader`, which raises exactly the
failure the case names instead of writing a corrupt file and trusting it to produce
one.

### `/` joined the surface, and the last exemption left with it (ESZ-021)

Until Package 2.1 the contract carried one case, `unknown.get.rootNotFound`, with a
standing PHP exemption. Its reason was true at the time: the front controller was
mounted at `/api` and `/` was the static site, served by the web server, so answering
404 there would have been a bug rather than conformance.

The static export removed the Node server that used to answer `/`. PHP serves it now,
injecting the published content into the exported HTML, so the exemption's premise
stopped holding — and rather than being waived it was **deleted**, along with the case
it applied to, and replaced by seven real ones (`page.*`). The exemption set is now
empty, and `testTheExemptionSetIsExactlyWhatIsExpected` asserts it stays empty: an
exemption is a contract change, visible in a diff, never a way to quiet a runtime that
has stopped conforming.

Two properties of `/` are worth stating because they differ from the JSON surface:

- **It accepts `HEAD`.** `/api/health` and `/api/content` 405 on it. `/` is a document
  that crawlers and uptime monitors probe with `HEAD`, and refusing them would be a
  self-inflicted wound; nobody has ever needed `HEAD /api/health`.
- **It has no 500.** Where `GET /api/content` answers an opaque `STORAGE_FAILURE`, the
  page answers **200 with the exported defaults** and no `published-<revision>` ETag.
  The callers differ: a program can act on "unavailable", a visitor cannot, and an error
  page is strictly worse for them than slightly stale copy. Frozen as
  `publicPageFallbackOutcome`.

The ETag and `Cache-Control` are otherwise identical to `GET /api/content`, minted by
the same `EntityTag` from the same revision, so one publish invalidates both surfaces
together (`page.etagMatchesContentEndpoint`).

### The gap found while porting is closed

`galleryContentSchema.instagramCta.superRefine` pins that link id to
`instagram-more`, exactly as `contact.fixedLinkIds` pins its two, but the generator
emitted **no rule entry for it**. A consumer following this document literally would
have accepted a document Zod rejects.

Package 1.2 closed it upstream rather than locally: the rule is declared in
`contracts/semantic-rules.ts` as `gallery.instagramCtaFixedId`, a rejecting parity
case (`gallery.instagramCtaFixedId.invalid`) was added, and the artifacts were
regenerated — which is why the corpus is 39 cases and not 38. PHP now enforces a
declared rule like any other, and `SemanticRuleValidator::UNDECLARED_RULES` is gone
along with the workaround it documented.

---

## Part 4 — migration differences, as applied

Differences PHP introduced **on purpose**. Package 1.1 recorded them as planned;
Package 1.2 applied them to `contracts/http-contract.ts`, regenerated the artifacts
and retired the Express service, so what follows is settled contract rather than
intent. They are kept here because a reader comparing this repository against an
older deployment or an older copy of the artifacts needs to know which changes were
deliberate.

### `uptimeSeconds` left `GET /api/health` (applied, ESZ-013)

Shared-hosting PHP has no process to measure. Each request is its own process, so
the only honest values would be a constant, a per-request zero, or the machine's
uptime — none of which is what the field claimed to report, and all of which would
have satisfied the old `health.uptimeMonotonic` invariant while meaning nothing. A
field that cannot be true is worse than an absent one.

Carried out together: the field was removed from `healthResponseSchema`, the
`health.uptimeMonotonic` invariant was removed with it, `contracts/generated/` was
regenerated, and the Express handler and its assertions went with the service. The
frozen 200 body is now `status`, `service`, `contentSchemaVersion`, `timestamp` and
nothing else.

### Health does not touch storage (applied, ESZ-013)

`/api/health` is frozen at 200, 400 and 405, with no 500. Package 1.1's kernel
booted content storage on every request, which would have made both of those
statements false once a health route existed: an editor's bad publish would have
read as an outage, and a 500 would have been reachable on a path that does not list
one.

Resolved by moving storage out of `boot()`. `HealthEndpoint` reads no file and takes
no lock; content problems surface on `/api/content` as the 500 the contract already
freezes for them. The property is now an invariant in the contract itself,
`health.doesNotDependOnContentStorage`, and is replayed by the conformance suite.

A failure *before* routing — unusable configuration, corrupt artifacts — still
answers 500 on any path. That is stated separately under `bootstrapFailure` (Part 1)
precisely so it is not read as a failure mode of health.

### An over-limit request body is 400 `INVALID_JSON` (applied, ESZ-013)

The cap existed from ESZ-002 but named no outcome, and the two implementations had
drifted: Express fell through to a 500 `INTERNAL_ERROR`, PHP answered 400
`INVALID_JSON`. PHP's answer was frozen — it reuses the existing error model instead
of widening it, and 400 is the honest class for a body this service will not
process. It is enforced before routing and regardless of `Content-Type`, so an
oversized body is a 400 even on a path that would otherwise 404 or 405. See
`overLimitBodyOutcome` in `contracts/http-contract.ts`.

No frozen route accepts a body, so this is a guard rather than a request-validation
rule. A write route that later accepts bodies may need a dedicated code; that will be
a deliberate contract change.

### Reads take a shared lock (applied, ESZ-014)

Package 1.1 took the *exclusive* content lock unconditionally at bootstrap, because
bootstrap might seed. With per-request bootstrap that serialised every request
behind a write that almost never happens. Reads now take `LOCK_SH`; the exclusive
lock is reserved for seeding and writing, and seeding re-checks under it. This is an
implementation property, not a contract one — it changes no response.

---

## Part 5 — Express, retired (ESZ-015)

The Express service in `API/` was the executable reference implementation of this
contract from ESZ-002 until Package 1.2. It is **removed**. PHP replays the same
`http-contract.json` cases, so the contract kept its executable proof while losing
its second runtime.

It was retired rather than kept because a second implementation of a frozen surface
is only worth its maintenance while it is the one being ported *from*. Once PHP
passed every case, Express's remaining effect would have been to hold the contract
to Node-shaped decisions — `uptimeSeconds` is exactly that: it survived one package
longer than it should have because a Node process could answer it.

What went with it: `API/` and its tests, `API/Dockerfile` and `.dockerignore`, the
`api:*` validation gates, and the Docker deployment target described in
`docs/backend-target-architecture.md`. `contracts/` no longer has a second Node
consumer; `front/` remains the only one.

Historical detail about the Express service survives in
`docs/backend-target-architecture.md`, `docs/runtime-inventory.md` and the dated
audit notes under `docs/`. All of it describes a runtime that no longer exists in
this repository, and is labelled as such.
