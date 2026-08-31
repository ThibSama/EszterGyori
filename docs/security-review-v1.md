# V1 security review (Package 8.2, ESZ-084)

An evidence-based review of the frozen V1 surface, and the fixes made in response.
Every finding below was reached by reading the code and the generated contract, and
every P0/P1 was **fixed in this package** rather than recorded for later — a
findings list with no diff attached is a list of things that are still true.

Where a claim cannot be proved from this repository it is marked NOT PROVABLE HERE
and says what would prove it. Nothing in this document is inferred from a scan that
was not run.

Scope: authentication, session and cookie flags; CSRF; login throttling; public
booking abuse; enumeration and error leakage; uploads; SQL parameterisation;
XSS and template escaping; secrets and configuration permissions; private paths;
customer PII in logs; notification diagnostics; and the carried 64 kB/1 MB limit
question.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | No rate limiting anywhere on the surface | **P1** | Fixed — `rateLimitPolicy`, `PdoRateLimiter` |
| 2 | Media catalogue cap enforced only on read, wedging the delete that would fix it | **P1** | Fixed — enforced on write |
| 3 | No Content-Security-Policy or Permissions-Policy | **P2** | Fixed — both sent |
| 4 | 64 kB request limit vs 1 MB storage cap, unreconciled | **P2** (carried) | Resolved — boundary proved intentional and asserted |
| 5 | Ranged booking read bounded by dates but not by rows | **P2** | Fixed — row cap from the contract |
| 6 | `IN (...)` list interpolated into notification SQL | **P3** | Reviewed — not reachable by a caller; left as is with the reasoning recorded |
| 7 | Admin e-mail written to the log on a failed login | **P3** | Reviewed — deliberate and correct |
| 8 | Dependency advisories were classified as live-only and never audited | **P1** | Fixed — authoritative complete and production lock audits plus gate |

Seven areas were reviewed and found sound with no change needed; they are listed in
§9 rather than omitted, because "we looked and it was fine" is a result.

## Dependency advisory audit closure (ESZ-084, 2026-08-21)

The Package 8.2 classification was wrong: dependency advisory scanning is a build
gate, while only host/package inspection is deployment-owned. The authoritative
lockfile audits were run online with Node v24.18.0, npm 11.16.0, Composer 2.9.5 and
PHP 8.5.4:

| Locked set | Initial result | Resolution / final result |
|---|---|---|
| Composer complete | 0 advisories, 0 abandoned | unchanged; 0 / 0 |
| Composer `--no-dev` production set | 0 advisories, 0 abandoned | unchanged; 0 / 0 |
| contracts npm complete and production | 0 advisories | unchanged; 0 |
| front npm production | 4 high advisory package findings | Next.js and its build dependencies updated within major 16; 0 |
| front npm complete | the production findings plus 2 high lint-tool findings | lock-compatible transitive updates; 0 |

The initial frontend findings covered Next.js 16.2.9 and its bundled PostCSS/Sharp/
Nanoid build graph, plus `brace-expansion` and `js-yaml` below linting tools. The
deployed artifact contains no Node runtime, no Next server, no image optimizer and
no lint tool, so the server-only exploit paths were not live. They were still
applicable to the trusted build input and were fixed without a major upgrade:
`next` and `eslint-config-next` moved together to 16.3.2 and only their allowed
transitive graph moved. No Composer lock changed. There are no residual lower-risk
or non-applicable advisories to waive.

Repeat with `npm run security:dependencies`. It records tool versions and runs six
audits: Composer complete/production, then each npm lock complete/production. Any
advisory or abandoned Composer package fails the gate; inability to reach or parse
an authoritative registry also fails rather than being reported as clean. The same
gate is the first executable step of `npm run validate`.

---

## 1. No rate limiting anywhere — P1, fixed

**Evidence.** `grep -ri 'rate.?limit|throttl|lockout|attempts'` over `php/src` and
`contracts/` returned one hit, and it was a comment. Nothing on the surface counted
anything.

**Why it is P1.** Three routes are reachable with no session, and each spends
server resources an anonymous caller gets for free:

- `POST /api/auth/login` performs an Argon2 verification — deliberately expensive,
  and it runs on *every* attempt including the ones against addresses that do not
  exist, because `Authenticator` verifies against a decoy hash to close the timing
  oracle. Password guessing was bounded only by network bandwidth.
- `POST /api/bookings` takes a row lock on the singleton serialization row and
  writes three tables. One script could fill a real person's calendar in a second,
  and every junk booking also enqueues e-mail.
- `POST /api/booking/availability` recomputes up to 90 days of slots per call.

**Fix.** `rateLimitPolicy` in the frozen contract, and `Eszter\Security\*` in PHP.
The design is §2 below. Refusal is 429 `RATE_LIMITED` with `Retry-After`, decided
before the route does any work.

**Proved by** `php:security` (routing, ordering, the enumeration property, the
forwarding-header bypass) and `sql:rate-limits` (everything that is a property of
the store, including two operating-system processes racing the last allowance).

## 2. The media catalogue cap was a one-way trap — P1, fixed

**Evidence.** `MediaLibrary::MAX_INDEX_BYTES` was compared against `filesize()` in
`readIndex()` and nowhere else. `writeIndex()` did not check it.

**Why it is P1 despite being hard to reach.** `media-library.json` grows by one
entry per upload and no request bounds the total — it is the *only* storage cap on
this surface a caller can reach through normal use. Every media operation reads the
catalogue first, and that includes delete, which has to read it to find the entry.
So crossing the cap produced a state with no way back: the media surface answered
500, and the one operation that could have made the file smaller was among the ones
that had stopped working. Recovery meant editing JSON on the host by hand.

A limit that can only be enforced after it has been exceeded is not a limit.

**Fix.** The cap is checked against the bytes about to be written. An upload that
would cross it is refused with the frozen 413 `PAYLOAD_TOO_LARGE` while the library
is still completely readable and every asset still deletable, and nothing of the
refused upload is left behind — `publishAsset()` unlinks what it had placed and the
ingest unlinks the intake and staging files.

**Proved by** `MediaLibraryCapTest`, which lowers the cap through a legitimately
re-signed contract copy rather than uploading five thousand images: the second
upload is refused, the catalogue on disk is byte-identical, the library still lists,
the asset still deletes, and the previously-refused upload then succeeds.

## 3. No Content-Security-Policy or Permissions-Policy — P2, fixed

**Evidence.** The generated `.htaccess` sent `X-Content-Type-Options`,
`Referrer-Policy` and `X-Frame-Options`, and nothing else.

**Fix, and an honest limit.** `script-src` carries `'unsafe-inline'` and will keep
carrying it. The Next export emits eight inline hydration scripts and ESZ-021's
injector adds a ninth; Apache serves those documents as static files, so there is
no request in which a nonce could be minted, and the one document PHP *does* rewrite
is the page whose inline blocks are the thing being rewritten. The script directive
is therefore weak, deliberately and visibly.

It is still worth sending, because four directives close attacks the inline
allowance has nothing to do with:

- `base-uri 'self'` — an injected `<base>` silently repoints every relative script
  URL at an attacker's host. It needs no inline script and is invisible in the
  rendered page.
- `object-src 'none'` — `<object>`/`<embed>` execution, which neither `nosniff` nor
  the script directive covers.
- `form-action 'self'` — an injected form cannot post the administrator's input
  anywhere but here, so an injection cannot become an exfiltration channel.
- `frame-ancestors 'self'` — clickjacking, enforced by browsers that ignore
  `X-Frame-Options`. `'self'` rather than `'none'`: ESZ-035's admin preview embeds
  this origin in a same-origin iframe.

`Permissions-Policy` denies camera, microphone, geolocation, payment, USB and the
rest. Their browser default is to allow, so silence is a grant.

**NOT PROVABLE HERE:** that Apache applies any of it. `SecurityHeadersTest` proves
the directives are rendered and `DocumentRootRoutingTest` proves the committed file
matches the routing table byte for byte; whether `mod_headers` is present on the
plan is a property of a deployed origin, and `smoke:http` stays NOT RUN.

## 4. The 64 kB / 1 MB question — resolved, and the boundary is intentional

The carried item. `REQUEST_BODY_LIMIT` is 64 kB; `ContentStorage` refused a content
file over 1 MB. Read as a pair they look like a contradiction.

They are not. They bound different things, and the **direction** of the inequality
is what makes the pair safe:

- Every byte of editorial content reaches disk through
  `PUT /api/admin/content/draft`, whose body is `{expectedRevision, content}`. The
  largest document that can be saved is therefore ~64 kB, and the largest file that
  can result is that plus the stored envelope's `revision` and `updatedAt` — about
  65 kB, against a 1 MB cap. The canonical default document is 7.8 kB, so the
  reachable ceiling is already about eight times the real content and the storage
  cap is fifteen times beyond that.
- The storage cap is a **read guard**, not a write budget: it exists for the file
  the application did not write — restored from a backup, hand-edited on the host,
  truncated by a full disk — where reading an unbounded file into memory to discover
  it is unusable is the failure worth preventing.

The dangerous arrangement is the mirror image: a storage cap *below* the request
limit, where a save is accepted, fsynced, renamed into place, and then refused by
the very next read. That is content destroyed by the rule meant to protect it, and
it cannot happen while `contentFileLimitBytes > requestBodyLimitBytes`.

**Fix.** The three on-disk caps moved into the contract as `storageLimits`, with the
invariant stated and asserted on both sides — `contracts/tests/generated-artifacts.test.ts`
and `StorageLimitReconciliationTest`. PHP now reads them from the artifact instead
of restating them, which is what let finding #2 be spotted at all: a number with no
declared relationship to the request limit cannot be checked against it.

The media catalogue was the one cap that was genuinely wrong, and it is §2.

## 5. A ranged booking read had no row bound — P2, fixed

**Evidence.** `BookingRepository::listBetween()` bounded its date range and nothing
else. `adminQuery` caps the range at 90 days, but a range is not a bound on rows:
how many bookings fall inside 90 days is decided by how busy the site is, not by
the query, so both the response size and the memory the method allocated were
unbounded.

**Fix.** `LIMIT` at `booking.policy.limits.maxResults`, the same ceiling the slot
engine already applies to the other unbounded list on this surface — so the two
cannot drift into different ideas of "too many". Far above what one practitioner
can book in a quarter, which makes it a guard rather than pagination: reaching it
means something has gone wrong, not that a page is missing.

**Proved by** `sql:integration`.

## 6. Interpolated `IN (...)` in notification SQL — P3, reviewed, no change

`NotificationJobRepository::skipStaleTimeSensitiveJobs()` interpolates
`$this->policy->timeSensitiveJobTypes` into an `IN` list rather than binding it.

It is not injectable: the values come from `http-contract.json`, which is
digest-verified against `manifest.json` at boot, and no request path can influence
them. Recorded rather than silently accepted, because it is the one place in the
codebase where SQL is assembled from a value rather than bound, and the next person
to read it deserves to find the reasoning already written down instead of having to
re-derive it.

Everything else is parameterised. `grep` for SQL keywords adjacent to a `$` variable
over `php/src` returns this and one table-name interpolation in the test helper
that drops tables from a database already proved disposable.

## 7. The admin e-mail is logged on a failed login — P3, reviewed, no change

`Authenticator::login()` writes the normalised address to the log on every
rejection. This is deliberate and documented in the code: an operator investigating
a lockout needs to know which address was being tried. The password is not logged,
anywhere, ever, and the log lives outside the document root.

It is the one identifier this application writes about a *person* rather than about
a request, and it is about the site's own administrator rather than a customer. Left
as is; noted so that the log file's retention is understood to be personal-data
retention.

## 8. Rate limiting: the design

Frozen as `rateLimitPolicy` in `http-contract.json`; PHP reads it and refuses to
boot on a policy it cannot honour.

### Deterministic, and never process-local

The target is Hetzner shared hosting, where **every request is its own PHP
process**. Anything held in a static, an opcache entry, an APCu slot or `$_SESSION`
is invisible to the next request, so a limiter built on any of them counts to one
and stays there — it does not throttle, it only looks like it does, which is worse
than nothing because it is believed. APCu is not guaranteed on the plan and is
per-pool where it exists; `$_SESSION` is per-caller and an abuser simply sends no
cookie.

The database is the one store every process on this host can see, and every limited
route already opens it.

### GCRA, not a fixed window

Each bucket stores one instant, the theoretical arrival time. A request is admitted
when `tat <= now + delayTolerance` and admission sets `tat = max(tat, now) + emissionInterval`.

- No window boundary, so `limit` requests really is the most that can arrive in any
  period — a fixed window lets `2 × limit` through across a boundary.
- One timestamp per bucket, so the whole decision is a single conditional `UPDATE`
  and never a read-then-write race.
- `delayTolerance` is `(burst - 1) * emissionInterval`, not `burst * …`. The
  textbook form admits `burst + 1` requests at one instant because the first costs
  nothing; that off-by-one is harmless in a paper and misleading in a contract where
  `burst: 5` has to mean five.

The clock is the application's injected clock, never the database's `NOW()` — a rule
the tests cannot move time through is a rule nobody proves.

### Never transactional

The charge is at most two autocommitted statements and is deliberately *not* wrapped
in a transaction. The routes it guards open their own, and PHP's nesting counter
would fold the limiter's into the caller's — so a booking that rolled back would roll
back the allowance it had just spent, and a script could retry forever at zero cost.
A limiter whose charge is undone by the failure it was meant to bound is not a
limiter.

Admission is read from MySQL's own affected-row count, which is race-free because
the engine holds the row lock for the duration of the statement. A refused charge
writes nothing at all, so hammering a full bucket cannot lengthen the penalty.

### The buckets

| Scope | Subject | Limit | Period | Burst |
|---|---|---|---|---|
| `auth.login.address` | client address | 10 | 15 min | 5 |
| `auth.login.identity` | submitted e-mail | 30 | 15 min | 10 |
| `booking.create.address` | client address | 5 | 1 h | 3 |
| `booking.create.global` | constant `all` | 60 | 1 h | 20 |
| `booking.availability.address` | client address | 120 | 1 h | 30 |

Two design points that are not obvious:

**The per-identity login budget is the wide one.** This site has a single operator,
so a tight per-identity limit would hand any anonymous caller a reliable way to lock
the only administrator out of their own site by failing logins on their behalf. The
narrow per-address bucket is what actually bounds guessing; the identity bucket is
wide enough that reaching it means a real distributed attack.

**Narrowest bucket first, and stop at the first refusal.** The per-address bucket is
charged before the per-identity one, so a caller hammering one address exhausts
their *own* allowance and is refused before spending any of the operator's.
Otherwise the narrow bucket would be pointless — reaching it would already have
burned the wide one. Same reasoning puts per-address booking ahead of the global
ceiling: one abusive source must not spend the allowance that exists to absorb a
distributed attack.

### The bypass that is closed

The client address comes from `REMOTE_ADDR` and never from `X-Forwarded-For`,
`X-Real-IP` or `Forwarded`. A header the caller writes is a bypass with extra steps:
the first thing an abuser would do is send a fresh one per request, and every
per-address bucket would then hold exactly one hit forever.
`forwardedHeadersTrusted` is `false` in the contract and PHP asserts it. Putting
this application behind a rewriting proxy is a deliberate contract change with a
declared trusted-proxy list, not a default.

A request with no peer address is charged to a shared `unknown` bucket rather than
skipping the limiter, or "arrive without one" would be the documented way past every
rule.

### Privacy

The stored key is `sha256(scope + NUL + subject)` as raw bytes. The table holds no
address and no e-mail in clear — a counter store that also happens to be a durable
record of who visited and when is a personal-data store, and would then need the
retention treatment the log file gets. The NUL separator is what stops scope `a` +
subject `bc` and scope `ab` + subject `c` from sharing a row.

### Enumeration

A throttled login is byte-identical whether or not the submitted address names an
account: same status, same code, same headers. The limiter runs before the account
lookup and cannot become the oracle `auth.loginFailure` exists to prevent.
`RateLimitGuardTest` asserts the two refusals are identical values.

### Failing closed

A database error refuses the request. Admitting on failure would turn any way of
making the limiter throw into a way of switching it off, which is the first thing
worth attacking about a limiter.

---

## 9. Reviewed and sound — no change needed

- **Session cookie.** `__Host-` prefix, `HttpOnly`, `SameSite=Strict`, `Path=/`, no
  `Domain`, and `Secure` forced in production by `Configuration`. The prefix is
  dropped exactly when `Secure` is off, so the prefixed name is present if and only
  if the browser will enforce it — a non-production cookie cannot be replayed under
  the name production trusts. Both expiry deadlines are enforced in the `WHERE`
  clause against the server-side row, never against the cookie's `Max-Age`.
- **CSRF.** 256-bit token bound to the session, rotated with the session id, carried
  in a header a browser will not attach on its own, compared with `hash_equals()`.
  Header only — not a query parameter, which would land in access logs and
  `Referer`. Anonymous sessions are real rows precisely so that
  `POST /api/auth/login` can be CSRF-checked too.
- **Authorization.** Re-read from the account directory on every request rather than
  trusted from the session, so disabling an account takes effect on its next request
  instead of its next login. `/admin` is a static file that enforces nothing, and the
  contract says so.
- **Enumeration at login.** Unknown address, wrong password and disabled account
  converge on one `throw` having each performed exactly one password verification
  against a lazily-computed decoy hash of the same algorithm and cost. The reason
  goes to the log; it is not expressible in the response.
- **Uploads.** Type decided by the bytes and confirmed against a closed allowlist;
  dimensions bounded before any decoder runs; end-of-stream marker required, so a
  truncated JPEG is refused rather than silently filled with grey; the served file
  is the server's own re-encode, so EXIF and appended payloads are absent from it;
  server-generated random name with an extension derived from the verified type;
  every refusal leaves no intake file, no original, no served file and no catalogue
  entry. `media/` removes the PHP handler and type, sends `nosniff` and
  `Content-Disposition: inline`, and serves only names matching the generated
  whitelist.
- **Public error surfaces.** Booking responses are opaque by contract — a reference,
  a service key, a state and two instants, with no customer data. Storage failures
  answer a fixed envelope; the detail goes to the log. Boot failure answers the
  frozen JSON envelope rather than an HTML error page or a stack trace.
- **Secrets and configuration.** Configuration is a file, not environment variables,
  and production refuses to boot on a placeholder value, an empty one, an insecure
  session cookie, or a config file readable by group or others. `DatabaseException`
  scrubs the DSN and user out of its message. The production artifact verifier
  rejects any config or environment file. The deployment layout keeps `config/`,
  `data/`, `var/` and `backups/` outside the document root, and the `.htaccess`
  denies `.json`, `.log`, `.lock`, `.sql`, `.env` and `composer.*` as defence in
  depth for a plan that cannot.
- **Notification diagnostics.** A frozen key allowlist; no customer name, address,
  phone, note or database credential reaches any log line, and a transport that
  throws an unexpected error has its message classified as transient and discarded
  rather than stored. Proved against real MySQL by `sql:notifications`.
- **XSS in the injected page.** The bootstrap payload is JSON that no editorial
  string can break out of, only the two elements located by id are rewritten, the
  rest of the export is carried through byte-identical, and the appearance block
  emits only values that validate as hex colours.

---

## 10. What remains live-only

None of these can be proved from a repository, and none of them is claimed:

- Apache actually applying both `.htaccess` files, including `mod_headers` and
  therefore every header in §3. (`smoke:http`, `security:config` — NOT RUN.)
- HTTPS and HSTS, which stay commented out until a certificate exists. Sending HSTS
  before HTTPS works is an outage a browser remembers long after the header is
  withdrawn.
- Private sibling paths being unreachable over HTTP.
- `config/config.php` being mode `0600` on the host.
- The PHP version and extensions actually present.
- A dependency advisory scan against a live database.
