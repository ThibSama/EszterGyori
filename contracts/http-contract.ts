import { z } from "zod";
import { isoTimestampSchema } from "./content-envelopes.js";
import { SITE_CONTENT_SCHEMA_VERSION, siteContentSchema } from "./site-content.js";
import {
  BOOKING_ADMIN_HISTORY_PAGE_SIZE,
  BOOKING_ADMIN_RANGE_PAGE_SIZE,
  BOOKING_ADMIN_SUMMARY_MAX_LISTED_ENTRIES,
  BOOKING_CONSENT_CURRENT_NOTICE_ID,
  BOOKING_DST_FOLD_OFFSETS,
  BOOKING_TIME_ZONE,
  bookableServiceKeys,
  bookingConsentNoticeIds,
  bookingStates,
} from "./booking.js";

/**
 * Frozen HTTP contract for the public, authentication, CMS, media and booking surfaces.
 *
 * This module is the single source of truth for the wire behaviour of
 * `GET /api/health` and `GET /api/content`. It is deliberately free of any
 * Express, Next.js, filesystem or Node runtime dependency so that the future
 * PHP implementation can be checked against the generated, language-neutral
 * artifacts in `contracts/generated/` without running Node.
 *
 * ## Liveness vs readiness (ESZ-127/AUD-22)
 *
 * `GET /api/health` answers **liveness**: it reads no file, takes no lock and
 * touches no database, so its 200 means only that the PHP service can boot and
 * answer. Composed-product readiness — the live health payload, the exported
 * public page, a valid published envelope on `/api/content`, and
 * `/api/booking/services` reaching the real booking surface with at least one
 * active bookable service — is deliberately NOT part of this HTTP contract:
 * the shared-hosting target exposes no `/api/readiness` endpoint. Readiness is
 * the project-owned read-only probe in `scripts/readiness.mjs` (CLI wrapper
 * `scripts/readiness-cli.mjs`, npm `readiness:probe`), which production
 * acceptance reuses; its checks are documented in `docs/production-acceptance.md`
 * and `docs/contract-freeze.md`.
 *
 * Bumping HTTP_CONTRACT_VERSION is a breaking change for every consumer.
 */
export const HTTP_CONTRACT_VERSION = 2;

export const API_SERVICE_NAME = "eszter-api";

/** Header used to accept and echo a caller-supplied correlation id. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Inbound request ids are only trusted when they match this pattern. */
export const REQUEST_ID_PATTERN = "^[A-Za-z0-9._:-]{1,80}$";

/** Generated request ids always use this prefix. */
export const REQUEST_ID_PREFIX = "req_";

/** Cache-Control emitted by `GET /api/content`, for both 200 and 304. */
export const CONTENT_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** Path of the public marketing page. Served by PHP on the target host (ESZ-021). */
export const PUBLIC_PAGE_PATH = "/";

/** Content-Type of the public page, on 200 and on 405 it is the error envelope instead. */
export const PUBLIC_PAGE_CONTENT_TYPE = "text/html; charset=utf-8";

/** Authenticated admin surface. Added in Package 2.2 (ESZ-025). */
export const AUTH_LOGIN_PATH = "/api/auth/login";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";
export const AUTH_SESSION_PATH = "/api/auth/session";

/** Authenticated admin content surface. Added in Package 3.1 (ESZ-030/031/032/033). */
export const ADMIN_CONTENT_DRAFT_PATH = "/api/admin/content/draft";
export const ADMIN_CONTENT_PUBLISH_PATH = "/api/admin/content/publish";
export const ADMIN_CONTENT_RESET_PATH = "/api/admin/content/reset";

/** Authenticated admin media surface. Added in Package 3.3 (ESZ-036/037). */
export const ADMIN_MEDIA_PATH = "/api/admin/media";

/** Booking backend surface. Added in Package 4.3 (ESZ-046/047/048). */
export const PUBLIC_BOOKING_AVAILABILITY_PATH = "/api/booking/availability";
export const PUBLIC_BOOKING_SERVICES_PATH = "/api/booking/services";
export const PUBLIC_BOOKINGS_PATH = "/api/bookings";
export const ADMIN_BOOKINGS_QUERY_PATH = "/api/admin/bookings/query";
export const ADMIN_BOOKING_MOVE_AVAILABILITY_PATH =
  "/api/admin/bookings/move-availability";
export const ADMIN_BOOKINGS_PATH = "/api/admin/bookings";
export const ADMIN_BOOKINGS_SUMMARY_PATH = "/api/admin/bookings/summary";

/**
 * The availability administration surface (ESZ-063/064).
 *
 * Three paths rather than one, because they are three different things and the
 * split is what keeps the CSRF rule readable. `/query` is a read: it needs a
 * session and nothing else. `/weekly` is a *replacement* of the entire recurring
 * schedule, so it is a PUT on the resource it replaces. `/exceptions` is neither
 * a read nor a whole-resource replacement — it is a closure, an exceptional
 * opening or a removal on one local date — so it is a PATCH carrying its action.
 */
export const ADMIN_AVAILABILITY_QUERY_PATH = "/api/admin/availability/query";
export const ADMIN_AVAILABILITY_WEEKLY_PATH = "/api/admin/availability/weekly";
export const ADMIN_AVAILABILITY_EXCEPTIONS_PATH =
  "/api/admin/availability/exceptions";

/**
 * Header reporting the current head of the content revision sequence.
 *
 * It exists because the error envelope is strict and must stay that way: a
 * caller that loses an optimistic-concurrency race needs to know *which*
 * revision it lost to, and the only alternatives were widening the frozen
 * envelope for one endpoint family or making the client issue a second request
 * to find out. A response header carries the value without touching either.
 *
 * Sent on exactly the responses that read the sequence under a lock — the 200s
 * of the three admin content routes and their 409 — and on nothing else. An
 * unauthenticated or CSRF-rejected caller never learns it, because those
 * requests never reach storage.
 */
export const CONTENT_REVISION_HEADER = "x-content-revision";

/**
 * Cache-Control emitted by every `/api/admin/content/*` response.
 *
 * `no-store`, not `no-cache`: a draft is unpublished editorial work, and the
 * difference between the two is whether a copy is allowed to exist on disk at
 * all. `no-cache` permits storage and merely requires revalidation, which would
 * leave drafts in a browser cache — and, on a shared machine, in one readable
 * after logout. There is also nothing to gain: the draft is read by one editor
 * on demand and changes on every save, so no cache would ever serve a hit.
 */
export const ADMIN_CONTENT_CACHE_CONTROL = "no-store";

/** Header carrying the per-session CSRF token on every state-changing request. */
export const CSRF_HEADER = "x-csrf-token";

/** Name of the session cookie. Prefixed so a non-Secure copy cannot shadow it. */
export const SESSION_COOKIE_NAME = "__Host-eszter_session";

/**
 * Cookie attributes the session cookie must carry.
 *
 * `__Host-` is not decoration: the prefix makes the browser refuse the cookie
 * unless it is `Secure`, `Path=/` and carries no `Domain`, which removes
 * subdomain injection as a way to plant a session id. The attributes below are
 * therefore both the policy *and* what the prefix already enforces, stated
 * explicitly so an implementation cannot satisfy the name and not the substance.
 *
 * `Secure` is dropped only when the configured environment is not production, so
 * a developer on plain HTTP can still log in; a production configuration that
 * turns it off must fail to boot (ESZ-027) rather than serve a downgradeable
 * cookie.
 */
export const sessionCookie = {
  name: SESSION_COOKIE_NAME,
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/",
  domain: null,
  requirements: [
    "The id is opaque and generated from a cryptographic source; it encodes no account data.",
    "The server-side record is authoritative. A cookie whose id has no record is treated as anonymous and the id is never adopted.",
    "The id is rotated on every privilege change, which for this surface means on successful login.",
    "Logout destroys the server-side record first and expires the cookie second, so a replayed cookie cannot outlive the record.",
  ],
} as const;

/**
 * CSRF lifecycle (ESZ-026).
 *
 * SameSite=Strict is a useful second lock but not the mechanism: it is a browser
 * behaviour, not a server check, it does not exist for non-browser clients, and
 * it has historically been relaxed by user agents. The server therefore requires
 * a token it issued itself on every state-changing request.
 *
 * The token is bound to the session — including the *anonymous* session, which is
 * what allows `POST /api/auth/login` to be protected too. A login CSRF, where an
 * attacker silently signs a victim into an account the attacker controls, is a
 * real attack on an editing surface: everything the victim then writes lands in
 * the attacker's account. The anonymous token closes it.
 */
export const csrfContract = {
  header: CSRF_HEADER,
  issuedBy: `${AUTH_SESSION_PATH} and ${AUTH_LOGIN_PATH}, in the response body`,
  boundTo: "the session, anonymous or authenticated",
  requiredOn: "every state-changing request, including login and logout",
  exemptFrom: `GET ${AUTH_SESSION_PATH}, public reads, and the authenticated reads ${ADMIN_BOOKINGS_QUERY_PATH}, ${ADMIN_BOOKINGS_SUMMARY_PATH} and ${ADMIN_AVAILABILITY_QUERY_PATH}; none changes state`,
  comparison: "constant-time",
  rotation:
    "A fresh token is minted whenever the session id rotates, so the token a caller holds before login is useless after it.",
  failure: { status: 403, errorCode: "CSRF_TOKEN_INVALID" },
  requirements: [
    "A missing, empty, malformed or non-matching token fails identically; the response distinguishes none of them.",
    "The token is never accepted from a query string or a form field on this surface, only from the header.",
    "The check runs after authentication is resolved, so an unauthenticated call to a protected route reports 401 rather than leaking that its token was also wrong.",
    "SameSite=Strict on the session cookie is required in addition, never instead.",
  ],
} as const;

/**
 * How a login failure is reported.
 *
 * One status, one code, one message, whatever actually went wrong: unknown
 * address, wrong password, or an account that exists and is disabled. Any
 * difference between those — a distinct code, a distinct message, or a
 * measurably distinct response time — is an account enumeration oracle.
 */
export const loginFailureOutcome = {
  status: 401,
  errorCode: "INVALID_CREDENTIALS",
  appliesTo: ["unknown email", "wrong password", "disabled account"],
  requirements: [
    "The three causes are indistinguishable in status, code, message and headers.",
    "A password verification is performed even when no account matched, so the response time does not reveal whether the address exists.",
    "No session is created, and any anonymous session's CSRF token is left usable so a retry does not need a new round trip.",
  ],
} as const;

/**
 * Where the published content is injected into the exported HTML.
 *
 * The static export bakes the canonical defaults into both elements, so the file
 * is a complete, indexable page on its own. On the target host PHP replaces the
 * contents of each element with the published document before sending
 * (`docs/hetzner-target-architecture.md` §5). Elements are located by `id`, never
 * by attribute order or surrounding markup, so a bundler that reorders attributes
 * cannot silently break injection.
 *
 * The two are separate on purpose. Appearance is a `<style>` in `<head>` because
 * it must be correct on the very first paint — a colour scheme that arrives with
 * React would be a visible flash. Content is a `type="application/json"` script,
 * inert to the parser, read by React after hydration.
 */
export const publicPageBootstrap = {
  contentElementId: "__ESZTER_CONTENT__",
  contentElementTag: "script",
  contentElementType: "application/json",
  appearanceElementId: "__ESZTER_APPEARANCE__",
  appearanceElementTag: "style",
  appearanceSelector: ":root",
  requirements: [
    "The injected JSON is the published content envelope, already validated against published-content-envelope.output.schema.json.",
    "Encoding must neutralise `<`, `>` and `&` inside the payload, so that no editorial string can terminate the script element or introduce markup. `'` and `\"` are additionally escaped by an encoder that can do so without touching JSON's structural delimiters; escaping them is not what makes the payload safe, and the result must remain parseable JSON either way.",
    "The appearance block emits only CSS custom properties whose values passed hexColorSchema; nothing else from the document reaches CSS.",
    "When the published document cannot be read or validated, the exported file is served unchanged so the page renders the baked-in canonical defaults. It must never render an error page.",
    "When either element is absent from the exported file, the file is served unchanged and the failure is logged; a partially injected page is never sent.",
  ],
} as const;

/**
 * How the public page degrades when published content is unusable.
 *
 * This is the one place where `/` and `GET /api/content` deliberately differ. The
 * API answers an opaque 500 `STORAGE_FAILURE`, because its caller is a program
 * that can distinguish "no content" from "old content". The page answers 200 with
 * the baked-in defaults, because its caller is a person looking at a marketing
 * site and an error page is strictly worse than slightly stale copy.
 *
 * The fallback carries no `published-<revision>` ETag: there is no revision behind
 * it, and minting one would let a cache pin the fallback in place of the content
 * it is standing in for.
 */
export const publicPageFallbackOutcome = {
  status: 200,
  body: "the exported HTML with its baked-in canonical defaults",
  appliesTo: ["storage read failure", "storage validation failure", "missing bootstrap elements"],
  requirements: [
    "No `published-<revision>` ETag is sent.",
    "Cache-Control is unchanged, so the next request revalidates rather than caching the fallback.",
    "The failure is logged with its detail; the response body leaks nothing about it.",
  ],
} as const;

/** Maximum accepted request body size, enforced before routing. */
export const REQUEST_BODY_LIMIT = "64kb";

/** `REQUEST_BODY_LIMIT` in bytes, so a consumer need not parse the suffix. */
export const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * What happens to a body over `REQUEST_BODY_LIMIT` (frozen in Package 1.2).
 *
 * The cap existed from ESZ-002 but named no outcome, so the two implementations
 * had drifted: Express fell through to a 500 `INTERNAL_ERROR`, PHP answered 400
 * `INVALID_JSON`. PHP's answer is the one that was frozen, for two reasons. It
 * reuses the existing error model instead of widening it — no new code, and the
 * per-endpoint status lists below stay exactly as they are — and 400 is the
 * honest class: the caller sent something this service will not process, which is
 * the caller's problem, not an internal fault.
 *
 * The cap is enforced on **any** request carrying a body, not only on bodies the
 * service would have parsed, and it is enforced before routing — so an oversized
 * body is a 400 even on a path that would otherwise be a 404 or a 405. How an
 * implementation detects the size (declared `Content-Length`, bytes actually
 * read) is not frozen; refusing at the cap is.
 *
 * No frozen route accepts a request body at all, so this is a guard rather than a
 * request-validation rule. A write route that later accepts bodies may need a
 * dedicated code; that is a contract change, made deliberately.
 */
export const overLimitBodyOutcome = {
  status: 400,
  errorCode: "INVALID_JSON",
  scope: "any request body, regardless of Content-Type",
  enforcedBefore: "routing",
} as const;

/**
 * The on-disk caps, moved into the contract by ESZ-084.
 *
 * They were previously three PHP constants, which is why nothing noticed that one
 * of them was enforced in the wrong place: a number with no declared relationship
 * to the request limit cannot be checked against it. See
 * {@link storageLimitReconciliation} for what each one is for.
 */
export const CONTENT_FILE_LIMIT_BYTES = 1024 * 1024;
export const MEDIA_LIBRARY_INDEX_LIMIT_BYTES = 1024 * 1024;
export const EXPORTED_PAGE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * ESZ-084 — the relationship between the request limit and the storage caps.
 *
 * Package 3.x left two numbers side by side with nothing stating how they
 * related: `REQUEST_BODY_LIMIT` is 64 kB, and `ContentStorage` refuses a
 * `draft.json` or `published.json` over 1 MB. Read as a pair they look like a
 * contradiction, and the carried question was whether one of them was wrong.
 *
 * Neither is. They bound different things, and the direction of the inequality is
 * what makes the pair safe rather than merely different.
 *
 * ## The request limit is the binding one, and it is the smaller one
 *
 * Every byte of editorial content reaches disk through `PUT /api/admin/content/draft`,
 * whose body is `{expectedRevision, content}`. So the largest document that can
 * ever be *saved* is 64 kB minus that envelope, and the largest file that can
 * result is that document plus the stored envelope's own `revision` and
 * `updatedAt` — on the order of 65 kB, against a 1 MB cap. The canonical default
 * document is about 7.8 kB, so the reachable ceiling is already roughly eight
 * times the real content and the storage cap is fifteen times beyond *that*.
 *
 * The dangerous arrangement is the mirror image of this one: a storage cap
 * *below* the request limit, where a save is accepted, written, and then refused
 * on the next read — content destroyed by a rule that only speaks up afterwards.
 * That cannot happen while `storageFileLimitBytes > requestBodyLimitBytes`, and
 * the assertion below is what keeps a later edit from quietly inverting it.
 *
 * ## So the storage cap is a read guard, not a write budget
 *
 * It exists for the file the application did not write: one restored from a
 * backup, hand-edited on the host, or truncated by a full disk. Reading an
 * unbounded file into memory to discover it is unusable is the failure the cap
 * prevents, and it is deliberately generous because refusing to read a file the
 * service *did* legitimately write would be the worse outcome of the two.
 *
 * ## The media catalogue is the one place the caps had to be aligned
 *
 * `media-library.json` is the exception that made this worth resolving rather
 * than merely documenting. It is not bounded by any request: each upload appends
 * an entry, so the file grows monotonically with use, and its 1 MB cap is
 * genuinely reachable. Worse, the cap was enforced only on *read* — and delete is
 * a read — so crossing it would have wedged the media surface into a state where
 * the only operation that could shrink the file was the one that had stopped
 * working.
 *
 * The fix is `enforcedOnWrite`: the cap is now checked before the catalogue is
 * written, so an upload that would cross it is refused while the library is still
 * fully readable and every asset is still deletable. A limit that can only be
 * enforced after it has been exceeded is not a limit.
 */
export const storageLimitReconciliation = {
  requestBodyLimitBytes: REQUEST_BODY_LIMIT_BYTES,
  contentFileLimitBytes: CONTENT_FILE_LIMIT_BYTES,
  mediaLibraryIndexLimitBytes: MEDIA_LIBRARY_INDEX_LIMIT_BYTES,
  exportedPageLimitBytes: EXPORTED_PAGE_LIMIT_BYTES,
  invariant: "contentFileLimitBytes > requestBodyLimitBytes",
  invariantReason:
    "A storage cap below the request limit would accept a save and then refuse to read it back, destroying content with a rule that only speaks up afterwards.",
  contentCapRole:
    "A read guard for a file the application did not write — restored, hand-edited or truncated — not a write budget. The reachable ceiling over HTTP is the request limit, which is smaller by design.",
  mediaLibraryCapRole:
    "A real write budget, because the catalogue grows with every upload and no request bounds it.",
  enforcedOnWrite: ["mediaLibraryIndexLimitBytes"],
  enforcedOnWriteReason:
    "Reading the catalogue is how a delete finds its entry, so a cap enforced only on read would make the one operation that could shrink an over-sized catalogue the one operation that had stopped working. Refusing the upload that would cross the cap keeps every asset deletable.",
  overSizedMediaLibraryOutcome: {
    status: 413,
    errorCode: "PAYLOAD_TOO_LARGE",
    note: "The upload is refused and nothing is stored: no intake file, no original, no derivative and no catalogue entry.",
  },
} as const;

/**
 * What a request gets when the service cannot finish starting up.
 *
 * Frozen in Package 1.2 because the target runtime made it observable. Node
 * booted once at `listen()`, so a failed boot meant no server and no response at
 * all. PHP has no startup: configuration loading, contract-artifact digest
 * verification and storage initialisation happen inside the request, so a boot
 * failure is something a client actually receives.
 *
 * It is stated here rather than added to the per-endpoint status lists on
 * purpose. Those lists describe a service that started; this describes one that
 * did not, and it can happen on any path including `/api/health`. Folding a 500
 * into `/api/health`'s statuses would suggest health has a failure mode of its
 * own, which it does not — see `health.doesNotDependOnContentStorage`.
 */
export const bootstrapFailureOutcome = {
  status: 500,
  appliesTo: "any path, including /api/health",
  errorCodes: {
    INVALID_CONFIGURATION:
      "Unusable configuration, or contract artifacts that are missing or fail their manifest digest.",
    STORAGE_FAILURE: "Content storage could not be initialised.",
    INTERNAL_ERROR: "Any other failure before the request could be routed.",
  },
  requirements: [
    "The body is the frozen error envelope, never an HTML error page or a stack trace.",
    "X-Request-Id is present and repeated in error.requestId, under the same trusted-inbound rules as a normal response.",
    "The body leaks no filesystem path, storage file name or schema internal.",
    "The response carries no published-<revision> ETag.",
  ],
} as const;

/**
 * ETag format for published content. The revision is the only input, so an
 * unchanged revision must always produce a byte-identical ETag.
 */
export function createPublishedEtag(revision: number): string {
  return `"published-${revision}"`;
}

export const PUBLISHED_ETAG_PATTERN = '^"published-(0|[1-9][0-9]*)"$';

/**
 * Every error code the frozen surface is allowed to emit.
 *
 * Two joined in Package 3.3, and both had to, because the media surface is the
 * first one where a caller's request can fail for a reason the caller can *act*
 * on differently. Until now every 400 meant one thing to a client — "fix the
 * document" — so one code carried it. An upload has two distinct refusals: the
 * file is too big, which the person fixes by choosing a smaller file, and the
 * file is not an image this site accepts, which they fix by converting it. A
 * single `VALIDATION_FAILED` would collapse the two into one message that has to
 * guess, and the guess is wrong half the time.
 *
 * `MEDIA_REFERENCED` is the same argument for delete: "still in use" is not a
 * validation failure and not a revision conflict, and the only useful response to
 * it is to go and change the content that points at the asset.
 */
export const apiErrorCodes = [
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INVALID_JSON",
  "VALIDATION_FAILED",
  "INVALID_CREDENTIALS",
  "UNAUTHENTICATED",
  "CSRF_TOKEN_INVALID",
  "REVISION_CONFLICT",
  /** An upload over the route's own limit (ESZ-036). 413, never 400. */
  "PAYLOAD_TOO_LARGE",
  /** A delete refused because the draft or the published site still uses the asset (ESZ-037). */
  "MEDIA_REFERENCED",
  /** A requested booking start is no longer available after transactional revalidation. */
  "SLOT_UNAVAILABLE",
  /**
   * The caller exceeded a bucket in `rateLimitPolicy` (ESZ-084). 429, and never
   * folded into `INVALID_CREDENTIALS`: a throttled login and a wrong password are
   * different facts, and collapsing them would leave a person locked out with a
   * message telling them to check a password that was correct.
   */
  "RATE_LIMITED",
  "INVALID_CONFIGURATION",
  "STORAGE_FAILURE",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const requestIdSchema = z
  .string()
  .regex(new RegExp(REQUEST_ID_PATTERN), "Doit etre un identifiant de requete sur.");

/** Frozen shape of every non-2xx JSON body. */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.enum(apiErrorCodes),
        message: z.string().min(1),
        requestId: requestIdSchema,
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Frozen shape of the `GET /api/health` 200 body.
 *
 * `uptimeSeconds` was removed in Package 1.2 (ESZ-013). The target runtime is
 * shared-hosting PHP, where every request is its own process: the only values it
 * could report are a constant, a per-request zero, or the machine's uptime, and
 * none of those is what the field claims to measure. A field that cannot be true
 * is worse than an absent one, so it left the contract rather than becoming a
 * permanent per-implementation exemption. The object is strict, so an
 * implementation that keeps sending it fails validation.
 *
 * Health is **liveness**, nothing more (ESZ-127/AUD-22): a 200 proves the
 * service can boot and answer — never that the published content or the
 * booking/MySQL surface is usable. Readiness for those surfaces is the separate
 * project-owned probe in `scripts/readiness.mjs`; this contract deliberately
 * defines no `/api/readiness` endpoint.
 */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal(API_SERVICE_NAME),
    contentSchemaVersion: z.literal(SITE_CONTENT_SCHEMA_VERSION),
    timestamp: isoTimestampSchema,
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Normalised form of an admin login identifier (ESZ-024).
 *
 * Identity is an email address, lower-cased and trimmed. Normalisation is part of
 * the contract rather than an implementation detail because it decides *identity*:
 * if PHP and the provisioning tool disagreed on it, `Eszter@…` and `eszter@…`
 * would be two accounts on a table with a unique index, and one of them would be
 * unreachable. The unique index is on the normalised value, so the rule below is
 * what makes that index mean "one person".
 *
 * Deliberately no fuller RFC 5322 grammar: this address is never sent mail by
 * this surface, it is only compared. A stricter pattern would reject valid
 * addresses to no benefit.
 */
export const ADMIN_EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
export const ADMIN_EMAIL_MAX_LENGTH = 254;

export const adminEmailNormalization = {
  steps: ["trim surrounding whitespace", "lower-case using ASCII case folding only"],
  pattern: ADMIN_EMAIL_PATTERN,
  maxLength: ADMIN_EMAIL_MAX_LENGTH,
  note: "ASCII case folding, not locale-aware lower-casing: a Turkish locale would fold `I` to `ı` and split one identity into two.",
} as const;

export const adminEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(ADMIN_EMAIL_MAX_LENGTH)
  .regex(new RegExp(ADMIN_EMAIL_PATTERN), "Adresse e-mail invalide.");

/**
 * Password policy for admin accounts.
 *
 * A length floor and nothing else. Composition rules ("one digit, one symbol")
 * measurably reduce entropy by funnelling people into predictable shapes, and the
 * upper bound exists only because a hashing function fed an unbounded string is a
 * denial-of-service surface.
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 4096;

export const adminPasswordSchema = z
  .string()
  .min(ADMIN_PASSWORD_MIN_LENGTH)
  .max(ADMIN_PASSWORD_MAX_LENGTH);

/**
 * Body of `POST /api/auth/login`. Shape only, deliberately not policy.
 *
 * `adminEmailSchema` and `adminPasswordSchema` above govern *provisioning*. If
 * they governed login too, a submitted password shorter than the policy floor
 * would answer 400 while a wrong one of legal length answered 401, and the pair
 * would tell an attacker which of their guesses were even worth making. So the
 * wire schema asks only whether the two fields are present, are strings, and are
 * bounded; everything else about them is decided by the lookup, whose every
 * outcome is `loginFailureOutcome`.
 */
export const loginRequestSchema = z
  .object({
    email: z.string().min(1).max(ADMIN_EMAIL_MAX_LENGTH),
    password: z.string().min(1).max(ADMIN_PASSWORD_MAX_LENGTH),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Frozen shape of the 200 body of `GET /api/auth/session` and `POST /api/auth/login`.
 *
 * One shape for both, so the admin shell has exactly one function that reads the
 * current state and exactly one place the CSRF token comes from.
 *
 * `account` is null when anonymous rather than absent, so a client cannot mistake
 * a key it forgot to read for a key that was not sent. The object is strict: no
 * password hash, no session id, no internal account id ever appears here.
 */
export const authSessionResponseSchema = z
  .object({
    authenticated: z.boolean(),
    account: z
      .object({ email: z.string().min(1), lastLoginAt: isoTimestampSchema.nullable() })
      .strict()
      .nullable(),
    csrfToken: z.string().min(32),
  })
  .strict();

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const BOOKING_REFERENCE_PATTERN = "^bk_[0-9a-f]{32}$";
export const BOOKING_LOCAL_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
/**
 * Civil time of day on a real 24-hour clock, `HH:MM` in Europe/Paris.
 *
 * The hour and minute alternations are the point. A looser `\d{2}:\d{2}` is
 * shape-checking only: it admits `25:00` and `09:60`, which then travel through
 * every structural gate and die in the domain, so the same refusal is expressed
 * twice and the wire type means less than it looks like it means. Structurally
 * accepting exactly `00:00`–`23:59` makes the value's own type carry the range,
 * and leaves the domain to say the things only the domain knows: the window is
 * increasing, the wall time exists on that date, the fold is stated.
 *
 * This narrows nothing that was ever valid — every accepted value is unchanged
 * on the wire — and it does not replace {@link BookingTimePolicy}'s DST checks.
 */
export const BOOKING_LOCAL_TIME_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

const bookingReferenceSchema = z.string().regex(new RegExp(BOOKING_REFERENCE_PATTERN));
const bookingLocalDateSchema = z.string().regex(new RegExp(BOOKING_LOCAL_DATE_PATTERN));
const bookingLocalTimeSchema = z.string().regex(new RegExp(BOOKING_LOCAL_TIME_PATTERN));
const bookableServiceKeySchema = z.enum(bookableServiceKeys);
const bookingStateSchema = z.enum(bookingStates);
const bookingFoldOffsetSchema = z.enum(BOOKING_DST_FOLD_OFFSETS).nullable();

export const bookingAvailabilityRequestSchema = z
  .object({
    serviceKey: bookableServiceKeySchema,
    fromDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
  })
  .strict();

export const publicBookableServiceSchema = z
  .object({
    key: bookableServiceKeySchema,
    label: z.string().trim().min(1).max(160),
    durationMinutes: z.number().int().min(5).max(480),
  })
  .strict();

export const publicBookableServicesResponseSchema = z
  .object({ services: z.array(publicBookableServiceSchema) })
  .strict();

export const bookingSlotSchema = z
  .object({
    localDate: bookingLocalDateSchema,
    localStart: bookingLocalTimeSchema,
    foldUtcOffset: bookingFoldOffsetSchema,
    startsAtUtc: isoTimestampSchema,
    endsAtUtc: isoTimestampSchema,
  })
  .strict();

export const bookingAvailabilityResponseSchema = z
  .object({
    serviceKey: bookableServiceKeySchema,
    timezone: z.literal(BOOKING_TIME_ZONE),
    fromDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
    slots: z.array(bookingSlotSchema),
  })
  .strict();

/**
 * ESZ-142 — a consent notice id must name an entry of the immutable catalog.
 *
 * The enum is generated from `bookingConsentNoticeIds` in the booking-domain
 * contract, so a request can only name a notice the catalog actually carries:
 * a missing or unknown id is a structural 400 VALIDATION_FAILED before the
 * booking domain is reached, and the domain re-checks membership against the
 * same artifact for defence in depth. The wire carries the id of the notice
 * the client displayed — never notice text, which no schema field accepts.
 */
const bookingConsentNoticeIdSchema = z.enum(bookingConsentNoticeIds);

export const publicBookingCreateRequestSchema = z
  .object({
    serviceKey: bookableServiceKeySchema,
    startsAtUtc: isoTimestampSchema,
    customerName: z.string().trim().min(1).max(160),
    customerEmail: z.string().trim().email().max(254),
    customerPhone: z.string().trim().max(32).nullable(),
    customerNote: z.string().trim().max(2000).nullable(),
    consentNoticeId: bookingConsentNoticeIdSchema,
    consentAccepted: z.literal(true),
  })
  .strict();

export const publicBookingResponseSchema = z
  .object({
    reference: bookingReferenceSchema,
    serviceKey: bookableServiceKeySchema,
    state: z.literal("confirmed"),
    startsAtUtc: isoTimestampSchema,
    endsAtUtc: isoTimestampSchema,
  })
  .strict();

/**
 * ESZ-144 — the typed continuation of one admin booking range read.
 *
 * The cursor names the keys of the last booking row the previous page ended
 * on: `startsAtUtc` is the row's start instant and `reference` its booking
 * reference. The next page begins strictly after those keys in
 * (starts_at_utc, reference) order, which is what makes equal instants page
 * without duplication or gaps. A cursor is opaque to the client — echo it,
 * never build one — and the server re-validates it against the requested
 * window before reading.
 */
export const adminBookingsCursorSchema = z
  .object({
    startsAtUtc: isoTimestampSchema,
    reference: bookingReferenceSchema,
  })
  .strict();

/**
 * ESZ-145 — the typed continuation of one booking history walk.
 *
 * The cursor names the monotonic `booking_history` row id of the last event
 * the previous page exposed. The next page begins strictly after that id in
 * ascending id order — the same order history events are stored and served in
 * — which is what makes paging advance without duplication or gaps. A cursor
 * is opaque to the client: echo it, never build one. The server validates the
 * id's shape and refuses a non-positive one before reading.
 */
export const bookingHistoryCursorSchema = z
  .object({
    eventId: z.number().int().min(1),
  })
  .strict();

/**
 * ESZ-144 — the pagination facts every admin booking read response carries.
 *
 * `pageSize` is the fixed server page capacity, `hasMore` is true exactly when
 * another page of the same range exists, and `nextCursor` carries the typed
 * cursor for that next page — null whenever `hasMore` is false. The server
 * detects a further page by fetching pageSize+1 rows, never by clipping.
 */
export const adminBookingsPageSchema = z
  .object({
    pageSize: z.literal(BOOKING_ADMIN_RANGE_PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: adminBookingsCursorSchema.nullable(),
  })
  .strict();

export const adminBookingsQueryRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("reference"),
      reference: bookingReferenceSchema,
      /**
       * ESZ-145 — optional history continuation. `eventId` is the monotonic
       * booking_history row id of the last event the previous page exposed;
       * the next page begins strictly after it. Absent means the first page.
       */
      historyCursor: bookingHistoryCursorSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("range"),
      fromDate: bookingLocalDateSchema,
      untilDate: bookingLocalDateSchema,
      cursor: adminBookingsCursorSchema.optional(),
    })
    .strict(),
]);

export const adminBookingMoveAvailabilityRequestSchema = z
  .object({
    reference: bookingReferenceSchema,
    fromDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
  })
  .strict();

export const bookingHistoryEventSchema = z
  .object({
    type: z.enum(["created", "moved", "cancelled", "customer_updated"]),
    actor: z.enum(["public", "admin"]),
    occurredAt: isoTimestampSchema,
  })
  .strict();

/**
 * ESZ-145 — the pagination facts of one booking history page.
 *
 * `pageSize` is the fixed server page capacity (50 events), `events` holds at
 * most that many events in chronological order, `hasMore` is true exactly when
 * a further page of the same booking's history exists, and `nextCursor`
 * carries the typed cursor for that next page — the id of the last exposed
 * event — null whenever `hasMore` is false. The server detects a further page
 * by fetching pageSize+1 events, never by clipping.
 */
export const adminBookingHistoryPageSchema = z
  .object({
    pageSize: z.literal(BOOKING_ADMIN_HISTORY_PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: bookingHistoryCursorSchema.nullable(),
    events: z.array(bookingHistoryEventSchema),
  })
  .strict();

/**
 * ESZ-145 — the current-state booking facts every admin response carries.
 *
 * Deliberately no `history` array: range reads and mutation responses return
 * exactly these facts (and zero history SQL per booking), and the reference
 * detail read returns them beside one fixed history page rather than embedding
 * an unbounded trail inside the booking object.
 */
export const adminBookingSchema = z
  .object({
    reference: bookingReferenceSchema,
    serviceKey: bookableServiceKeySchema,
    state: bookingStateSchema,
    startsAtUtc: isoTimestampSchema,
    endsAtUtc: isoTimestampSchema,
    timezone: z.literal(BOOKING_TIME_ZONE),
    customerName: z.string().min(1).max(160),
    customerEmail: z.string().email().max(254),
    customerPhone: z.string().max(32).nullable(),
    customerNote: z.string().max(2000).nullable(),
    consentAtUtc: isoTimestampSchema,
    cancelledAtUtc: isoTimestampSchema.nullable(),
    cancellationReason: z.string().max(500).nullable(),
    createdAt: isoTimestampSchema,
    /**
     * ESZ-139: the V1 optimistic-concurrency token of this booking. It
     * changes on every successful admin mutation, is exposed by every admin
     * read, and is sent back byte-for-byte as `expectedUpdatedAt` on the next
     * mutation. There is deliberately no separate revision column.
     */
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const adminBookingsResponseSchema = z
  .object({
    bookings: z.array(adminBookingSchema),
    page: adminBookingsPageSchema,
  })
  .strict();

/**
 * ESZ-145 — the reference detail read: the booking's current facts beside one
 * fixed, explicitly bounded page of its history.
 */
export const adminBookingReferenceResponseSchema = z
  .object({
    booking: adminBookingSchema,
    historyPage: adminBookingHistoryPageSchema,
  })
  .strict();

export const adminBookingResponseSchema = z
  .object({ booking: adminBookingSchema })
  .strict();

/**
 * ESZ-139 — admin booking mutations carry the V1 optimistic-concurrency token.
 *
 * Each mutation sends the booking's own `updatedAt`, read from an admin
 * response, back as `expectedUpdatedAt`. The server compares it byte-for-byte
 * with the current row under the authoritative row lock; a mismatch is 409
 * `REVISION_CONFLICT` and writes no history and schedules no notification. The
 * token is the canonical UTC millisecond `updatedAt` — no revision column is
 * added.
 */
const adminBookingUpdateSchema = z
  .object({
    action: z.literal("update"),
    reference: bookingReferenceSchema,
    expectedUpdatedAt: isoTimestampSchema,
    customerName: z.string().trim().min(1).max(160),
    customerEmail: z.string().trim().email().max(254),
    customerPhone: z.string().trim().max(32).nullable(),
    customerNote: z.string().trim().max(2000).nullable(),
  })
  .strict();

const adminBookingMoveSchema = z
  .object({
    action: z.literal("move"),
    reference: bookingReferenceSchema,
    expectedUpdatedAt: isoTimestampSchema,
    startsAtUtc: isoTimestampSchema,
  })
  .strict();

const adminBookingCancelSchema = z
  .object({
    action: z.literal("cancel"),
    reference: bookingReferenceSchema,
    expectedUpdatedAt: isoTimestampSchema,
    reason: z.string().trim().max(500).nullable(),
  })
  .strict();

export const adminBookingMutationRequestSchema = z.discriminatedUnion("action", [
  adminBookingUpdateSchema,
  adminBookingMoveSchema,
  adminBookingCancelSchema,
]);

/**
 * Availability administration (ESZ-063/064) and the operational summary (ESZ-065).
 *
 * These are frozen before any PHP or React exists for them, for the usual reason
 * and one specific one: the weekly editor is a *replacement* surface, and a
 * replacement surface that is not frozen tends to grow per-row create/update/
 * delete calls, which is exactly the shape that can leave half a schedule behind
 * when the third call fails. Freezing `rules` as one array on one PUT makes the
 * atomicity a property of the contract rather than a property of how carefully
 * the client sequences its requests.
 */
export const ADMIN_AVAILABILITY_MAX_WEEKLY_RULES = 100;
export const ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS = 12;
export const ADMIN_AVAILABILITY_MAX_RANGE_DAYS = 400;
export const ADMIN_AVAILABILITY_NOTE_MAX_LENGTH = 255;
export const ADMIN_SUMMARY_MIN_UPCOMING_DAYS = 1;
export const ADMIN_SUMMARY_MAX_UPCOMING_DAYS = 90;
export const ADMIN_SUMMARY_DEFAULT_UPCOMING_DAYS = 7;
export const availabilityRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * One local civil window. `foldUtcOffset` is null for every ordinary time and is
 * only meaningful on the autumn fall-back date, where the same wall clock happens
 * twice and the server refuses to guess which one was meant.
 */
export const availabilityWindowSchema = z
  .object({
    startLocal: bookingLocalTimeSchema,
    endLocal: bookingLocalTimeSchema,
    foldUtcOffset: bookingFoldOffsetSchema,
  })
  .strict();

const availabilityWeeklyRuleFields = {
  weekdayIso: z.number().int().min(1).max(7),
  startLocal: bookingLocalTimeSchema,
  endLocal: bookingLocalTimeSchema,
  foldUtcOffset: bookingFoldOffsetSchema,
  validFrom: bookingLocalDateSchema.nullable(),
  validUntil: bookingLocalDateSchema.nullable(),
  isActive: z.boolean(),
};

/** What an editor submits. It carries no id: the whole set is replaced. */
export const adminAvailabilityWeeklyRuleInputSchema = z
  .object(availabilityWeeklyRuleFields)
  .strict();

/** What the server returns. The id is assigned by the replacement, never sent. */
export const adminAvailabilityWeeklyRuleSchema = z
  .object({ id: z.number().int().nonnegative(), ...availabilityWeeklyRuleFields })
  .strict();

export const adminAvailabilityWeeklyReplaceRequestSchema = z
  .object({
    expectedRevision: availabilityRevisionSchema,
    rules: z
      .array(adminAvailabilityWeeklyRuleInputSchema)
      .max(ADMIN_AVAILABILITY_MAX_WEEKLY_RULES),
  })
  .strict();

export const adminAvailabilityWeeklyResponseSchema = z
  .object({
    timezone: z.literal(BOOKING_TIME_ZONE),
    revision: availabilityRevisionSchema,
    weeklyRules: z.array(adminAvailabilityWeeklyRuleSchema),
  })
  .strict();

export const adminAvailabilityExceptionSchema = z
  .object({
    id: z.number().int().nonnegative(),
    localDate: bookingLocalDateSchema,
    kind: z.enum(["closed", "open"]),
    windows: z.array(availabilityWindowSchema).max(ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS),
    note: z.string().max(ADMIN_AVAILABILITY_NOTE_MAX_LENGTH).nullable(),
  })
  .strict();

export const adminAvailabilityQueryRequestSchema = z
  .object({
    fromDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
  })
  .strict();

export const adminAvailabilityResponseSchema = z
  .object({
    timezone: z.literal(BOOKING_TIME_ZONE),
    fromDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
    revision: availabilityRevisionSchema,
    weeklyRules: z.array(adminAvailabilityWeeklyRuleSchema),
    exceptions: z.array(adminAvailabilityExceptionSchema),
  })
  .strict();

const adminAvailabilityCloseSchema = z
  .object({
    action: z.literal("close"),
    expectedRevision: availabilityRevisionSchema,
    localDate: bookingLocalDateSchema,
    note: z.string().trim().max(ADMIN_AVAILABILITY_NOTE_MAX_LENGTH).nullable(),
  })
  .strict();

const adminAvailabilityOpenSchema = z
  .object({
    action: z.literal("open"),
    expectedRevision: availabilityRevisionSchema,
    localDate: bookingLocalDateSchema,
    windows: z
      .array(availabilityWindowSchema)
      .min(1)
      .max(ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS),
    note: z.string().trim().max(ADMIN_AVAILABILITY_NOTE_MAX_LENGTH).nullable(),
  })
  .strict();

const adminAvailabilityRemoveSchema = z
  .object({
    action: z.literal("remove"),
    expectedRevision: availabilityRevisionSchema,
    localDate: bookingLocalDateSchema,
  })
  .strict();

export const adminAvailabilityExceptionMutationRequestSchema = z.discriminatedUnion("action", [
  adminAvailabilityCloseSchema,
  adminAvailabilityOpenSchema,
  adminAvailabilityRemoveSchema,
]);

/** `exception` is null after a removal, and only after a removal. */
export const adminAvailabilityExceptionResponseSchema = z
  .object({
    revision: availabilityRevisionSchema,
    exception: adminAvailabilityExceptionSchema.nullable(),
  })
  .strict();

export const adminBookingSummaryEntrySchema = z
  .object({
    reference: bookingReferenceSchema,
    serviceKey: bookableServiceKeySchema,
    startsAtUtc: isoTimestampSchema,
    endsAtUtc: isoTimestampSchema,
    localDate: bookingLocalDateSchema,
    localStart: bookingLocalTimeSchema,
    customerName: z.string().min(1).max(160),
  })
  .strict();

export const adminBookingsSummaryRequestSchema = z
  .object({
    upcomingDays: z
      .number()
      .int()
      .min(ADMIN_SUMMARY_MIN_UPCOMING_DAYS)
      .max(ADMIN_SUMMARY_MAX_UPCOMING_DAYS),
  })
  .strict();

/**
 * Cancelled bookings are counted, never listed, and never added to a confirmed
 * count. They are reported separately because "two cancellations today" is
 * operationally useful and silently dropping them would make the summary
 * disagree with the calendar the operator is looking at.
 *
 * ESZ-144: `counts` and `nextConfirmedStartsAtUtc` are exact over the whole
 * window (dedicated SQL aggregation), while the `today`/`upcoming` entry
 * collections are each bounded at the domain's `listedEntriesMax`. `listings`
 * states whether each collection is complete, so a bounded list can never be
 * read as the exhaustive answer — the operator is told when it is partial and
 * the counts remain the authority.
 */
export const adminBookingsSummaryResponseSchema = z
  .object({
    timezone: z.literal(BOOKING_TIME_ZONE),
    todayDate: bookingLocalDateSchema,
    untilDate: bookingLocalDateSchema,
    upcomingDays: z
      .number()
      .int()
      .min(ADMIN_SUMMARY_MIN_UPCOMING_DAYS)
      .max(ADMIN_SUMMARY_MAX_UPCOMING_DAYS),
    counts: z
      .object({
        todayConfirmed: z.number().int().nonnegative(),
        todayCancelled: z.number().int().nonnegative(),
        upcomingConfirmed: z.number().int().nonnegative(),
        upcomingCancelled: z.number().int().nonnegative(),
      })
      .strict(),
    nextConfirmedStartsAtUtc: isoTimestampSchema.nullable(),
    listings: z
      .object({
        todayComplete: z.boolean(),
        upcomingComplete: z.boolean(),
      })
      .strict(),
    today: z.array(adminBookingSummaryEntrySchema).max(BOOKING_ADMIN_SUMMARY_MAX_LISTED_ENTRIES),
    upcoming: z.array(adminBookingSummaryEntrySchema).max(BOOKING_ADMIN_SUMMARY_MAX_LISTED_ENTRIES),
  })
  .strict();

export const availabilityAdminPolicy = {
  maxQueryRangeDays: ADMIN_AVAILABILITY_MAX_RANGE_DAYS,
  maxWeeklyRules: ADMIN_AVAILABILITY_MAX_WEEKLY_RULES,
  maxExceptionWindows: ADMIN_AVAILABILITY_MAX_EXCEPTION_WINDOWS,
  authority:
    "availability_rules and availability_exceptions are canonical. The editor reads and replaces them; it never computes, caches or schedules anything the server would then have to trust.",
  revisionSetting: {
    key: "availability.revision",
    initial: 0,
    valueShape: { revision: "non-negative safe integer" },
  },
  optimisticConcurrency:
    "Weekly and exception writes contend on one durable global revision. A mutation locks it, compares expectedRevision before any availability write, then changes the schedule and increments exactly once in the same transaction. A stale request is 409 REVISION_CONFLICT, writes nothing and does not advance the revision.",
  weeklyReplacement:
    "PUT carries the complete intended rule set. The server validates all of it, then locks the global availability revision and deletes and reinserts inside one transaction, so a rejected or failed save leaves the previously stored schedule exactly as it was rather than a partial one.",
  weeklyRefusals: [
    "An ISO weekday outside 1-7.",
    "A window whose end is not strictly after its start.",
    "Two windows on the same weekday whose validity ranges intersect and whose times overlap.",
    "A validity end earlier than its validity start.",
    "A fold offset that is not one of Europe/Paris's two.",
  ],
  clientPrevalidation:
    "The browser may refuse a malformed set before sending it. That is a convenience and never an authority: the same set posted directly is refused by the same server rules.",
  adoptServerState:
    "Every successful mutation returns the stored state, and the editor renders what it was returned. No optimistic local schedule survives a response.",
  exceptionPrecedence:
    "One exception per local date replaces the weekly result for that date outright. Closed yields no windows; open yields exactly its ordered window set. Weekly and exception windows are never merged.",
  exceptionRemoval:
    "Removing the exception restores the weekly behaviour for that date; it is the only way back and it deletes no booking.",
  exceptionDst:
    "Each exception window boundary is converted with the Europe/Paris IANA rules at store time: a spring-forward gap is refused and an autumn fall-back overlap requires the explicit fold offset.",
  destructiveConfirmation:
    "Closing a date and removing an exception are confirmed explicitly in the UI before they are sent.",
  summary:
    "The operational summary stores nothing of its own. Counts and nextConfirmedStartsAtUtc are exact SQL aggregations over the whole window; listed entries are confirmed bookings in ascending start order, bounded at the domain's listedEntriesMax with the listings completeness flags, and cancelled bookings are reported in their own counts and never inflate a confirmed one.",
} as const;

export const bookingApiPolicy = {
  publicAvailability:
    "Only active canonical services and dates from the Paris-local today through day 90 inclusive; response order is SlotEngine order and slots are never persisted.",
  publicServices:
    "Lists only active canonical service keys with booking label and duration; editorial descriptions and media remain in SiteContent.",
  creation:
    "The client submits a returned UTC start. Inside one transaction the singleton primary resource row is locked, all inputs are re-read, SlotEngine recomputes, and insert plus created history commit together.",
  consent:
    "ESZ-142 — the request must pair consentAccepted: true with consentNoticeId naming the entry of the immutable notice catalog (booking-domain consentNotices) whose text the client displayed. The server accepts only an id the catalog contains and stores it beside consent_at_utc; it never accepts notice text. Bookings created before the catalog keep a null consent_notice_id and are never retro-attributed one.",
  adminMutableFields: {
    update: ["customerName", "customerEmail", "customerPhone", "customerNote"],
    move: ["startsAtUtc"],
    cancel: ["state", "cancelledAtUtc", "cancellationReason"],
  },
  optimisticConcurrency:
    "Admin booking responses expose the canonical UTC millisecond updatedAt, which doubles as the V1 optimistic-concurrency token of the row — there is no separate revision column. Update, move and cancel require expectedUpdatedAt and, inside the mutation transaction after the authoritative row lock and before any write, history append or notification scheduling, compare it byte-for-byte with the current updatedAt. A mismatch is 409 REVISION_CONFLICT and writes nothing; a fresh token lets the mutation proceed and store an updatedAt strictly later than the token it was granted against, even when the application clock returns the same millisecond or moves backward — the state timestamps advance by one derived mutation instant.",
  move:
    "Authenticated move availability resolves the booking server-side and delegates to SlotEngine while excluding only itself. Mutation retains reference and service, requires confirmed state, and transactionally recomputes the submitted returned instant.",
  history:
    "Append-only created, moved, cancelled and customer_updated events; the bookings row remains authoritative current state. ESZ-145: history is served only by mode=reference, one fixed page of at most 50 chronological events with explicit hasMore and a strictly advancing typed cursor; range reads and mutation responses carry current-state booking facts only and never a history array.",
  adminQuery:
    "An authenticated read, no CSRF. mode=reference is an exact lookup returning the booking's current facts beside one bounded page of its history (adminViews.historyPage: at most 50 events, chronological, hasMore from a pageSize+1 probe, typed eventId continuation). mode=range returns the bookings whose start falls in the requested Paris-civil window, deterministically ordered and paginated per adminViews.rangeRead: pageSize rows at most, a typed cursor for the next page, hasMore detected with a pageSize+1 probe — no row is silently clipped. Range rows carry current-state facts only: a range page costs a constant number of queries whatever its row count, and never one history read per booking.",
  adminSummary:
    "An authenticated read, no CSRF. Counts and nextConfirmedStartsAtUtc are exact SQL aggregations over the whole window; the today/upcoming entry lists are confirmed-only and bounded at adminViews.summary.listedEntriesMax with listings.todayComplete/upcomingComplete stating whether each list is complete.",
} as const;

/**
 * ESZ-084 — the frozen abuse-control policy.
 *
 * ## Why the server has to do this at all
 *
 * Three routes on this surface are reachable without a session and each of them
 * costs the server something an anonymous caller can spend for free:
 * `POST /api/auth/login` performs an Argon2 verification, `POST /api/bookings`
 * takes a row lock on the singleton serialization row and writes three tables,
 * and `POST /api/booking/availability` recomputes up to
 * `BOOKING_SLOT_MAX_HORIZON_DAYS` of slots. Until Package 8.2 none of them was
 * bounded: password guessing was limited only by network bandwidth, and one
 * script could fill a real person's calendar in a second.
 *
 * ESZ-130 adds a fourth: `GET /api/auth/session` with no live session opens a
 * durable anonymous row carrying a CSRF token, which is how a caller obtains the
 * token a later login needs — so a caller who never keeps the cookie could make
 * `admin_sessions` grow by one row per request forever. Unlike the three POST
 * routes its cost is storage, not computation, and the bound on it is the
 * `auth.session.bootstrap.address` bucket below, charged only for that
 * anonymous read.
 *
 * ## Deterministic, and never process-local
 *
 * The target is Hetzner shared hosting, where every request is a *new PHP
 * process*. Anything held in a static, an opcache entry, an APCu slot or a
 * `$_SESSION` is therefore invisible to the next request, so a limiter built on
 * any of them counts to one forever and enforces nothing. There is exactly one
 * store on this host that every request can see, and it is the database the
 * limited routes already open. `algorithm` is fixed here rather than left to the
 * implementation because two implementations that disagree about what "5 per
 * hour" means do not have the same contract.
 *
 * GCRA — the generic cell rate algorithm — rather than a fixed window, for one
 * reason that matters and one that is convenient. It has no window boundary, so
 * `limit` requests really is the most that can arrive in any `periodSeconds`,
 * where a fixed window lets `2 × limit` through across a boundary. And it needs
 * one timestamp per bucket instead of a counter plus a window start, so the whole
 * decision is a single conditional `UPDATE` and never a read-then-write race.
 *
 * The clock is the *application's* injected clock, never the database's
 * `NOW()`: a rule the tests cannot move time through is a rule nobody proves.
 *
 * ## What is keyed, and what is deliberately not
 *
 * `subjectHash` is `sha256(scope + "\0" + subject)`, stored as bytes. The
 * limiter's table therefore holds no address, no e-mail and nothing else a
 * `SELECT *` could turn back into a person — it is a counter store, not a log,
 * and it is subject to the same PII rule as the log file.
 *
 * The client address comes from the connection (`REMOTE_ADDR`) and never from
 * `X-Forwarded-For` or any other request header. A header the caller writes is a
 * bypass with extra steps: the one thing an abuser would do is send a fresh
 * `X-Forwarded-For` per request. If this application is ever put behind a proxy
 * that rewrites the client address, that is a deliberate contract change with a
 * declared trusted-proxy list, not a default.
 *
 * ## The refusals, and the enumeration rule
 *
 * A refusal is 429 `RATE_LIMITED` with `Retry-After` in whole seconds, and it
 * happens **before** the route does its work — before the password verification,
 * before the transaction. On login that ordering is also what keeps the frozen
 * `loginFailure` guarantee intact: a throttled login answers identically whether
 * or not the address names an account, so the limiter cannot become the
 * enumeration oracle that `INVALID_CREDENTIALS` was written to avoid.
 *
 * ## The per-identity login bucket is the generous one, on purpose
 *
 * Two buckets guard login: one keyed by address, one by the submitted identity.
 * They are not the same size and the asymmetry is the whole design. This site has
 * a single operator, so a tight per-identity limit would hand any anonymous
 * caller a reliable way to lock the only administrator out of their own site by
 * failing logins on their behalf. The per-identity budget is therefore wide
 * enough that reaching it means a real attack rather than a nuisance, and the
 * narrow per-address bucket is what actually bounds guessing.
 *
 * ## The anonymous session read is bounded at its own smaller rate (ESZ-130)
 *
 * `GET /api/auth/session` answers 200 normally and keeps doing so — nothing in
 * this ticket changes the happy path, the body or the 200 cases below. What
 * changes is who may *open* a session. A read that found a live session (any
 * live session, anonymous or signed-in) is free and never charged. A read with
 * no live session — no cookie, or a missing, malformed, invented or expired
 * one — is charged to `auth.session.bootstrap.address` (30 per hour, burst 10)
 * **before** the route creates the anonymous row and its CSRF token, so a
 * refused read creates no session, no token and no cookie, and its 429 body is
 * the frozen envelope plus `Retry-After`: it names no session, no account and
 * no address.
 *
 * Between an admitted anonymous read and the creation of its row the server
 * runs a bounded sweep of the session table, so the admission that pays for a
 * new row also pays for deleting the expired ones; the sweep never runs on a
 * request that found a live session, and it is the only production caller of
 * session garbage collection. The sweep is index-backed and bounded per pass
 * (the migrations add the `absolute_expires_at` index beside the existing
 * idle-expiry one), never probabilistic, and never deletes a live row — a
 * request whose sweep fails is refused through the same opaque error path and
 * creates no row.
 */
export const RATE_LIMIT_RETRY_AFTER_HEADER = "Retry-After";

export const rateLimitPolicy = {
  algorithm: "gcra",
  algorithmNote:
    "Per bucket the store holds one theoretical-arrival-time. emissionInterval = periodSeconds / limit; delayTolerance = (burst - 1) * emissionInterval, so `burst` is exactly the number of requests admitted at one instant rather than one more than it. A request is admitted when tat <= now + delayTolerance, and admission sets tat = max(tat, now) + emissionInterval; a refused request writes nothing at all. Retry-After is ceil(tat - delayTolerance - now), floored at one emissionInterval.",
  store: "database",
  storeNote:
    "One row per bucket in rate_limit_buckets, decided by a single conditional UPDATE so two concurrent processes cannot both be admitted by the same allowance. Process-local state is never used: on shared hosting each request is its own process and would see none of it.",
  clock: "application",
  subjectKey: "sha256(scope + NUL + subject), stored as bytes; no address or identity is stored in clear.",
  clientAddressSource: "REMOTE_ADDR",
  forwardedHeadersTrusted: false,
  refusal: {
    status: 429,
    errorCode: "RATE_LIMITED",
    retryAfterHeader: RATE_LIMIT_RETRY_AFTER_HEADER,
    retryAfterUnit: "seconds",
    enforcedBefore:
      "any work the route would otherwise do: no password verification, no transaction, no row lock, no slot computation.",
  },
  buckets: {
    "auth.login.address": {
      scope: "auth.login.address",
      subject: "client address",
      limit: 10,
      periodSeconds: 900,
      burst: 5,
      guards: "Password guessing from one origin.",
    },
    "auth.login.identity": {
      scope: "auth.login.identity",
      subject: "normalised submitted e-mail address",
      limit: 30,
      periodSeconds: 900,
      burst: 10,
      guards:
        "Distributed guessing against one account. Deliberately wide: a narrow per-identity budget would let an anonymous caller lock the site's only administrator out.",
    },
    // ESZ-130. The one GET the limiter guards. `GET /api/auth/session` with no
    // live session opens a durable anonymous row and a CSRF token (the token a
    // later login needs), so a caller who simply never keeps the cookie could
    // make the table grow by one row per request forever. Charged only for that
    // anonymous read — a read with a live session reuses the existing row and
    // is never charged — and charged before the row exists, so a refusal
    // creates no session, no token and no cookie.
    "auth.session.bootstrap.address": {
      scope: "auth.session.bootstrap.address",
      subject: "client address",
      limit: 30,
      periodSeconds: 3600,
      burst: 10,
      guards:
        "Repeated anonymous reads of GET /api/auth/session from one origin, each of which would otherwise mint a durable session row.",
    },
    "booking.create.address": {
      scope: "booking.create.address",
      subject: "client address",
      limit: 5,
      periodSeconds: 3600,
      burst: 3,
      guards: "One origin filling the calendar with junk reservations.",
    },
    "booking.create.global": {
      scope: "booking.create.global",
      subject: "the constant `all`",
      limit: 60,
      periodSeconds: 3600,
      burst: 20,
      guards:
        "Distributed booking spam, which the per-address bucket cannot see. It is a ceiling on damage, not a per-user quota: a genuine caller refused here is refused because the site is under attack, and the operator sees it in the log.",
    },
    "booking.availability.address": {
      scope: "booking.availability.address",
      subject: "client address",
      limit: 120,
      periodSeconds: 3600,
      burst: 30,
      guards:
        "Repeated 90-day slot recomputation. Wide enough that a person browsing the calendar never meets it.",
    },
  },
  retention:
    "A bucket row is expired once its tat is in the past by more than its period, and is swept opportunistically. Sweeping is never on the request's critical path and losing a row only forgives allowance, never grants it.",
  requirements: [
    "A refusal is decided before the route performs any work.",
    "A throttled login is byte-identical whether or not the submitted address names an account.",
    "An anonymous GET /api/auth/session (no live session found) is charged to auth.session.bootstrap.address before any session row or CSRF token exists; the refusal is 429 RATE_LIMITED with Retry-After and creates no session, no token and no cookie. A read that found a live session is never charged.",
    "A bounded, index-backed sweep of expired sessions runs between an admitted anonymous session read and the creation of its row, never on a request that found a live session, and never deletes a live row; a request whose sweep fails creates no row and is refused through the same opaque error path as any other internal failure.",
    "The response is the frozen error envelope plus Retry-After; it names no bucket, no limit and no remaining allowance.",
    "The limiter stores no address, e-mail or other personal datum in clear.",
    "An inbound X-Forwarded-For, X-Real-IP or Forwarded header never changes which bucket a request is charged to.",
    "Two concurrent processes presenting the last allowance admit exactly one of them.",
    "A limiter failure is logged and refuses the request rather than admitting it unbounded.",
  ],
} as const;

/**
 * Server-enforced authorization, restated because Package 2.1 removed the thing
 * that used to enforce it.
 *
 * `/admin` is a static file. It can redirect for the look of the thing, and that
 * is all it can do — anyone may fetch it, read it, and call whatever it calls. So
 * every guarantee below is a PHP guarantee, checked per request, and none of them
 * may be delegated to the shell.
 */
export const adminAccessControl = {
  shell: "/admin is a static export; it enforces nothing and is not access control.",
  authority: "PHP, per request, on every non-public endpoint.",
  requirements: [
    "An absent, unknown, expired or destroyed session id is anonymous, never partially authenticated.",
    "A disabled account is rejected at every request, not only at login, so disabling takes effect on the next call rather than at the next login.",
    "Authorization is never derived from a request header, an Origin, or anything else the caller controls.",
  ],
} as const;

/**
 * The content revision sequence (ESZ-031/032/033).
 *
 * Frozen before any of the write routes were written, because every one of them
 * depends on it and because the alternative — two independent counters, one per
 * file — is the design this replaces and cannot be made coherent. With separate
 * counters, `draft.revision` and `published.revision` are two numbers with no
 * defined relationship: a caller holding revision 4 cannot know whether it is
 * four saves into an unpublished draft or four publishes behind, and "is this
 * draft published?" has no answer that reading the files can give.
 *
 * So there is **one** sequence, and both files carry a value drawn from it:
 *
 *  - `draft.revision` is the **head**: the most recent state an editor saved.
 *  - `published.revision` names the **exact draft head that was published**. It
 *    is not a count of publishes.
 *
 * The invariant that makes this readable is `published.revision <= draft.revision`,
 * always, on every path. When the two are equal the published site is exactly the
 * draft; when they differ, the draft has unpublished work in it, and the
 * difference is not a number anyone needs to interpret — only the equality is.
 *
 * Transitions, and nothing else may move the sequence:
 *
 * | Operation | draft.revision | published.revision |
 * | --- | --- | --- |
 * | save draft   | `head + 1` | unchanged |
 * | publish      | unchanged  | `= draft.revision` |
 * | reset draft  | `head + 1` | unchanged |
 *
 * Reset bumps the head like any other write. It is a modification of the draft —
 * it destroys whatever unpublished work was there — and a caller holding the
 * pre-reset revision must lose its next save rather than silently overwrite the
 * reset. Leaving the head untouched would make reset the one draft mutation
 * invisible to the concurrency check.
 *
 * ## Why publish does not increment
 *
 * Publishing draft head N sets `published.revision = N`. It does not mint N+1.
 * Two consequences, both wanted:
 *
 *  - **Publish is idempotent.** Publishing an already-published draft rewrites
 *    the same content at the same revision, so it is safely retryable after a
 *    timeout — a client that cannot tell whether its publish landed may simply
 *    repeat it. The ETag does not change, because the content did not, which is
 *    exactly what `etag.derivedOnlyFromRevision` already requires: `publishedAt`
 *    moves and the validator must not.
 *  - **A publish that changes the site always changes the ETag.** If the draft
 *    was ahead at all, `published.revision` climbs from M to N with N > M, so
 *    `"published-M"` is retired and both `/` and `/api/content` revalidate. That
 *    is the invalidation requirement, satisfied by construction rather than by a
 *    cache-busting step someone has to remember.
 *
 * An incrementing publish counter would break both: it would make retry a
 * content-free revision bump that invalidates every cache for nothing, and it
 * would sever `published.revision` from the draft it came from.
 */
export const contentRevisionSemantics = {
  sequence: "one monotonic non-negative integer, shared by draft and published",
  draftRevision: "the head; the most recent saved draft state",
  publishedRevision: "the exact draft head that was published; not a count of publishes",
  invariant: "published.revision <= draft.revision at all times",
  transitions: {
    saveDraft: "draft.revision = head + 1; published untouched",
    publish: "published.revision = draft.revision; draft untouched",
    resetDraft: "draft.revision = head + 1; published untouched",
  },
  seed: "Both files seed at revision 0 from the canonical defaults, so a fresh deployment already satisfies the invariant.",
  requirements: [
    "The head is read under the same lock that writes it; a revision is never computed from a value read outside the lock that used it.",
    "Nothing outside these three operations moves either revision. Serving content never does.",
    "`publishedAt` and `updatedAt` change on every successful write, including a republish at an unchanged revision, and neither ever reaches the ETag.",
  ],
} as const;

/**
 * The one optimistic-concurrency mechanism (ESZ-031).
 *
 * Every state-changing admin content request carries `expectedRevision`, and the
 * server compares it against the draft head under the exclusive lock. Equal, the
 * write proceeds; different, the request is refused with 409 `REVISION_CONFLICT`
 * and storage is left byte-for-byte unchanged.
 *
 * ## Why this is frozen as *the* mechanism, singular
 *
 * A second way to express the same precondition is not redundancy, it is a hole:
 * whichever one a given client uses is the one that protects it, and a client
 * that uses neither is protected by nothing while looking like it is. So this is
 * the only mechanism, and the negative half is part of the contract —
 * `If-Match`, `If-Unmodified-Since` and any other conditional request header are
 * **ignored** on this surface. Not honoured, not rejected: ignored, because a
 * header that is sometimes a precondition and sometimes decoration is worse than
 * one that never is.
 *
 * ## Why a body field rather than `If-Match`
 *
 * `If-Match` is the better fit for exactly one of the three routes. `PUT
 * /api/admin/content/draft` is a conditional replacement of the resource at that
 * URL, and `If-Match` says so precisely. Publish and reset are not: they are
 * POSTs whose precondition is about the *draft*, which is a different resource
 * from the one being posted to, and `If-Match` on a POST has no agreed meaning
 * for that. Using it on the PUT and something else on the two POSTs would be the
 * two-mechanism hole above, one route at a time.
 *
 * The body field also lands inside the validated request schema, so a malformed
 * or absent precondition is a schema failure like any other rather than a header
 * parse the endpoint has to hand-roll — and a request that omits it cannot be
 * read as "no precondition intended".
 *
 * ## Where the caller gets the value
 *
 * From `x-content-revision` on any 200 or 409 of this surface, and from
 * `revision` in the body of a 200. A 409 therefore carries everything the client
 * needs to re-read, rebase and retry without guessing.
 */
export const optimisticConcurrency = {
  field: "expectedRevision",
  comparedAgainst: "draft.revision, read under the exclusive content lock",
  appliesTo: [
    `PUT ${ADMIN_CONTENT_DRAFT_PATH}`,
    `POST ${ADMIN_CONTENT_PUBLISH_PATH}`,
    `POST ${ADMIN_CONTENT_RESET_PATH}`,
  ],
  failure: { status: 409, errorCode: "REVISION_CONFLICT" },
  revisionHeader: CONTENT_REVISION_HEADER,
  ignoredHeaders: ["if-match", "if-unmodified-since", "if-none-match"],
  requirements: [
    "The comparison happens under the exclusive lock, after the authoritative draft has been re-read. A check against a value read before the lock is not this mechanism.",
    "A conflict writes nothing: no file is replaced, no temp file is left behind, and neither revision moves.",
    "A conflict response carries the current head in the revision header, so recovery needs no extra round trip.",
    "Conditional request headers are ignored on this surface; they are never a second way to state the precondition.",
    "The field is required. An absent expectedRevision is 400 VALIDATION_FAILED, never an unconditional write.",
  ],
} as const;

/**
 * Reading the server draft (ESZ-030).
 *
 * Authenticated, never cached, and the body is the same `serverDraftEnvelope`
 * that is on disk — normalised by the validator on the way out, exactly as
 * `GET /api/content` normalises the published one.
 *
 * No ETag and no conditional requests. The draft's validator would be the same
 * revision number the concurrency mechanism already carries in its own header,
 * and offering it twice under two names invites a client to use the wrong one as
 * a precondition. `no-store` and a fresh read every time is also simply correct
 * for a single-editor surface where every read follows a write the same person
 * just made.
 */
export const adminDraftReadOutcome = {
  status: 200,
  body: "server-draft-envelope.output.schema.json",
  cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
  requirements: [
    "The response is the validated, normalised draft envelope, including its revision.",
    "No ETag and no 304: the surface offers exactly one revision token, in the revision header.",
    "An absent, unknown, expired or destroyed session is 401 UNAUTHENTICATED, with no hint that a draft exists.",
    "A disabled account is 401 on this route too, resolved per request rather than at login.",
    "A draft that cannot be read or validated is 500 STORAGE_FAILURE and is never repaired, replaced or partially served.",
  ],
} as const;

/**
 * Saving the server draft (ESZ-031).
 *
 * The body carries a **complete** `SiteContent`, never a patch. The document is
 * validated whole — structure and every semantic rule — before anything is
 * written, so a rejected save leaves the stored draft exactly as it was.
 *
 * Whole-document replacement rather than a partial update is the same decision
 * §4 of the architecture makes about storage: the document is read whole and
 * written whole, it has a frozen schema and an executable parity corpus, and a
 * patch format would need a second validation story for the merged result that
 * the corpus does not cover. It also makes the concurrency check meaningful — a
 * caller that sends a whole document has necessarily seen a whole document.
 */
export const adminDraftSaveOutcome = {
  status: 200,
  body: "server-draft-envelope.output.schema.json",
  requestBody: "admin-draft-save-request.schema.json",
  requirements: [
    "The submitted content is validated against siteContent — structure *and* semantic rules — before any write.",
    "Validation failure is 400 VALIDATION_FAILED and leaves storage unchanged.",
    "The write is atomic: temp file, fsync, rename, under the exclusive lock. A reader never observes a partial draft.",
    "The 1 MB storage size cap and the request body limit both still apply; neither is relaxed for this route.",
    "Saving a draft never reads, writes or invalidates published content. The public site is unaffected.",
    "The response is the stored envelope at its new revision, so the client does not have to re-read to stay in sync.",
    "Every managed MediaAsset.src in the submitted content must exactly match a catalogued public path before the write; otherwise 400 VALIDATION_FAILED with no write and no revision bump (mediaReferenceIntegrity).",
  ],
} as const;

/**
 * Publishing (ESZ-032).
 *
 * The request body carries no content. Publish takes what is *stored*, not what
 * the caller sends: the authoritative draft is re-read and re-validated inside
 * the exclusive lock, and that re-read document is what becomes published. A
 * publish that accepted a body would be a save and a publish in one, and the
 * document it published would be one nothing had ever validated as a draft.
 *
 * ## The lock spans the whole operation
 *
 * Acquire exclusive → read draft → validate draft → compare expectedRevision →
 * write published atomically → release. Every step is inside. The read and the
 * write cannot be split across two lock acquisitions, because a save landing in
 * the gap would publish a document that was never the one checked.
 *
 * ## All-or-nothing
 *
 * One successful publish produces one coherent published envelope — content,
 * revision and `publishedAt` from the same operation. A failure at any step
 * leaves the previous published envelope intact and visible; there is no state in
 * which `/` or `/api/content` serves half a publish, because the only mutation is
 * a single `rename()`.
 *
 * A draft that fails re-validation is 500 STORAGE_FAILURE, not 400: the caller
 * sent nothing wrong, and the fault is a stored document that should never have
 * been storable. It is reported opaquely and logged in full, like every other
 * storage fault.
 */
export const adminPublishOutcome = {
  status: 200,
  body: "published-content-envelope.output.schema.json",
  requestBody: "admin-publish-request.schema.json",
  source: "the stored draft, re-read and re-validated under the lock; never the request body",
  requirements: [
    "The whole read-validate-compare-write sequence runs under one exclusive content lock acquisition.",
    "The published envelope's revision is the draft revision that was published (contentRevisionSemantics).",
    "The published envelope's content is byte-equal to the draft content that was re-read under the lock.",
    "A failure leaves the previous published envelope readable and unchanged; no partial state is ever observable.",
    "A stored draft that fails re-validation is 500 STORAGE_FAILURE, opaque in the body and detailed in the log.",
    "The stored draft's managed src values are re-checked against the catalogue inside the same lock acquisition; a dangling managed reference is 500 STORAGE_FAILURE and published.json stays readable and byte-identical (mediaReferenceIntegrity).",
    "The published ETag follows from the new revision automatically; there is no separate invalidation step to forget.",
    "Publishing does not modify the draft.",
  ],
} as const;

/**
 * Resetting the draft (ESZ-033).
 *
 * Discards the draft and rebuilds it from an explicitly named source. The only
 * source this package defines is the **current published content**.
 *
 * ## Why `source` is required despite having one legal value
 *
 * Because the operation is destructive and the field is what makes the caller say
 * what it is about to destroy the draft *in favour of*. A bare `POST
 * /api/admin/content/reset` reads as "reset to… whatever the server thinks",
 * which is precisely the ambiguity `docs/backend-target-architecture.md` left
 * open when it described this route as recreating the draft "from default or
 * published content". Naming it closes that, and a client written today against
 * `source: "published"` keeps meaning what it meant if `"defaults"` is ever
 * added.
 *
 * ## Published content is read, never written
 *
 * The reset reads `published.json` and writes only `draft.json`. There is no path
 * through this route that mutates published content, bumps its revision or
 * changes what the public site serves — which is the whole point of resetting
 * *to* it.
 */
export const adminResetOutcome = {
  status: 200,
  body: "server-draft-envelope.output.schema.json",
  requestBody: "admin-reset-request.schema.json",
  sources: ["published"],
  requirements: [
    "`source` is required and closed; an unknown value is 400 VALIDATION_FAILED.",
    "Published content is read under the lock and is never written, moved or revision-bumped by this route.",
    "The rebuilt draft is validated before it is written, exactly like a save.",
    "The new draft takes the next revision, so a concurrent editor holding the pre-reset revision loses its next save instead of silently undoing the reset.",
    "Auth, CSRF and expectedRevision apply exactly as they do to a save; reset is not a lighter operation.",
  ],
} as const;

/** The sources a draft reset may name. */
export const adminResetSources = ["published"] as const;

export type AdminResetSource = (typeof adminResetSources)[number];

const expectedRevisionSchema = z
  .number()
  .int("La revision attendue doit etre un entier.")
  .nonnegative("La revision attendue doit etre positive ou egale a zero.");

/** Body of `PUT /api/admin/content/draft`. */
export const adminDraftSaveRequestSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    content: siteContentSchema,
  })
  .strict();

export type AdminDraftSaveRequest = z.infer<typeof adminDraftSaveRequestSchema>;

/** Body of `POST /api/admin/content/publish`. Carries no content by design. */
export const adminPublishRequestSchema = z
  .object({ expectedRevision: expectedRevisionSchema })
  .strict();

export type AdminPublishRequest = z.infer<typeof adminPublishRequestSchema>;

/** Body of `POST /api/admin/content/reset`. */
export const adminResetRequestSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    source: z.enum(adminResetSources),
  })
  .strict();

export type AdminResetRequest = z.infer<typeof adminResetRequestSchema>;

// ── The authenticated media surface (ESZ-036 / ESZ-037) ────────────────────

/**
 * The V1 image allowlist, and why it is exactly these three.
 *
 * The site needs photographs: a hero, four service visuals, five gallery
 * visuals and a portrait (`mediaAssetIds`). Photographs are JPEG. PNG is here
 * because an editor exporting from a phone or a design tool routinely produces
 * one and telling them "convert it first" is a worse product than accepting it.
 * WebP is here because it is what a modern export pipeline emits and refusing it
 * would push editors back through a lossy round-trip.
 *
 * Nothing else. Specifically:
 *
 *  - **No SVG.** An SVG is a document, not a bitmap: it carries `<script>`,
 *    `<foreignObject>`, external references and CSS, and serving one from the
 *    site's own origin is a stored-XSS primitive on the origin that holds the
 *    admin session. Sanitising it safely means shipping and maintaining a full
 *    XML sanitiser, and the site has no vector artwork to justify one. If vector
 *    logos ever arrive, the honest answer is a separate, sanitised pipeline —
 *    not a fourth entry in this list.
 *  - **No GIF.** Animated, frequently a decompression bomb, and nothing on the
 *    page is animated artwork.
 *  - **No AVIF.** Broadly supported in browsers, but decoder support in the
 *    hosting PHP cannot be assumed (`gd_info()['AVIF Support']` is off on the
 *    build this repository was developed against), and a format the server
 *    cannot decode is a format the server cannot verify.
 *
 * Each entry pairs the **verified** media type with the single extension the
 * stored file may take. The extension is derived from this table and never from
 * the upload's filename, which is what makes `evil.php.jpg` and `../../x.jpg`
 * unrepresentable rather than merely filtered.
 */
export const mediaFormats = [
  { mimeType: "image/jpeg", extension: "jpg", imageType: "IMAGETYPE_JPEG" },
  { mimeType: "image/png", extension: "png", imageType: "IMAGETYPE_PNG" },
  { mimeType: "image/webp", extension: "webp", imageType: "IMAGETYPE_WEBP" },
] as const;

export type MediaMimeType = (typeof mediaFormats)[number]["mimeType"];

export const mediaMimeTypes = mediaFormats.map((format) => format.mimeType) as
  readonly MediaMimeType[];

/**
 * The multipart field carrying the image. Exactly one part, exactly this name.
 *
 * Named in the contract rather than left to the client because the server
 * refuses a request that carries any other part: an upload endpoint that ignores
 * unexpected parts is one that silently accepts whatever a future caller
 * attaches.
 */
export const MEDIA_UPLOAD_FIELD_NAME = "file";

/** The only Content-Type `POST /api/admin/media` accepts. */
export const MEDIA_UPLOAD_CONTENT_TYPE = "multipart/form-data";

/**
 * The upload's own body limit, in bytes, and why the global one is untouched.
 *
 * `REQUEST_BODY_LIMIT` is 64 kB and stays 64 kB. It is enforced before routing
 * on every request, and raising it so that one route could accept an image would
 * hand every *other* route — including the unauthenticated ones — a 128× larger
 * buffer to be asked to parse as JSON. The limit is a property of the route, so
 * it lives on the route.
 *
 * 8 MiB is chosen against the material: a full-frame JPEG straight off a camera
 * is 3–8 MB, a phone photo 1–4 MB, and a design-tool PNG export of a hero image
 * rarely passes 6 MB. Bigger than that is a raw file or a mistake, and the
 * refusal names the limit so the person can act on it.
 *
 * The limit applies to the **file part**, and the request as a whole is allowed
 * a small multipart overhead above it — boundaries, headers and the field name.
 * A server that applied the file limit to the whole envelope would reject a file
 * of exactly the maximum size, which is the one size a user is most likely to
 * have deliberately produced.
 */
export const MEDIA_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

/** Human form of {@link MEDIA_UPLOAD_LIMIT_BYTES}, for copy and for docs. */
export const MEDIA_UPLOAD_LIMIT = "8mb";

/** Multipart framing allowed on top of the file itself. */
export const MEDIA_UPLOAD_ENVELOPE_OVERHEAD_BYTES = 16 * 1024;

/**
 * Decoded-image bounds, checked **before** any decode is attempted.
 *
 * A 100 × 100 000 000 PNG is a few kilobytes on the wire and tens of gigabytes
 * once decoded, so a byte limit alone does not bound memory. The dimensions come
 * from the header inspection that already runs, and the pixel product is checked
 * against `MEDIA_MAX_PIXELS` before a decoder ever sees the file — which is the
 * only ordering that actually prevents the bomb rather than surviving it.
 *
 * 8000 px on a side is well past anything this site displays (the widest visual
 * renders at ~1600 CSS px on a desktop) and still accepts an unmodified
 * 24-megapixel camera frame.
 */
export const MEDIA_MAX_DIMENSION = 8000;
export const MEDIA_MIN_DIMENSION = 1;
export const MEDIA_MAX_PIXELS = 40_000_000;

/**
 * Stored asset ids: `med_` plus 128 bits of hex.
 *
 * Cryptographically random, not sequential and not derived from the file. A
 * sequential id would let anyone holding one URL enumerate every other asset,
 * including images an editor uploaded and has not published yet; a content hash
 * would make identical bytes collide into one id, so deleting one usage would
 * break the other. Random is the only one of the three with neither property.
 */
export const MEDIA_ASSET_ID_PREFIX = "med_";
export const MEDIA_ASSET_ID_PATTERN = "^med_[0-9a-f]{32}$";

/** Every managed asset is addressable here and nowhere else. */
export const MEDIA_PUBLIC_PATH_PREFIX = "/media/";
export const MEDIA_PUBLIC_PATH_PATTERN = "^/media/med_[0-9a-f]{32}\\.(jpg|png|webp)$";

export const mediaAssetIdSchema = z
  .string()
  .regex(new RegExp(MEDIA_ASSET_ID_PATTERN), "Doit etre un identifiant de media valide.");

export const mediaPublicPathSchema = z
  .string()
  .regex(new RegExp(MEDIA_PUBLIC_PATH_PATTERN), "Doit etre un chemin de media gere.");

/**
 * What the CMS is told about one stored asset — and, just as importantly, what
 * it is not.
 *
 * Every field here is something the editor's UI needs: the id to address the
 * asset, the path to put in `MediaAsset.src` and to preview, the media type and
 * the dimensions to show what was actually stored after re-encoding, the byte
 * size so "why is the page slow" has an answer, and the timestamp to sort by.
 *
 * Deliberately absent: the intake path, the original's path, the temp name, the
 * uploader's filename and anything else describing the server's disk. The
 * original never becomes addressable, so publishing its location would only be a
 * hint for someone probing for a way to reach it — and the client filename is
 * attacker-controlled text that would end up rendered in the admin UI for no
 * benefit the id and the preview do not already give.
 */
export const mediaAssetMetadataSchema = z
  .object({
    id: mediaAssetIdSchema,
    /** The public path, exactly what a `MediaAsset.src` may be set to. */
    path: mediaPublicPathSchema,
    /** The type of the **stored** file, after re-encoding. Never the declared one. */
    mimeType: z.enum(mediaMimeTypes as unknown as [MediaMimeType, ...MediaMimeType[]]),
    byteSize: z.number().int().positive(),
    width: z.number().int().min(MEDIA_MIN_DIMENSION).max(MEDIA_MAX_DIMENSION),
    height: z.number().int().min(MEDIA_MIN_DIMENSION).max(MEDIA_MAX_DIMENSION),
    uploadedAt: isoTimestampSchema,
  })
  .strict();

export type MediaAssetMetadata = z.infer<typeof mediaAssetMetadataSchema>;

/** Body of a 200 `GET /api/admin/media`. */
export const mediaLibraryResponseSchema = z
  .object({ assets: z.array(mediaAssetMetadataSchema) })
  .strict();

export type MediaLibraryResponse = z.infer<typeof mediaLibraryResponseSchema>;

/** Body of a 201 `POST /api/admin/media`. */
export const mediaUploadResponseSchema = z
  .object({ asset: mediaAssetMetadataSchema })
  .strict();

export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;

/**
 * Body of `DELETE /api/admin/media`.
 *
 * The id is in the body rather than in the path, and that is a deliberate
 * departure from what REST would suggest. `Router` is exact-path by
 * construction — "no pattern matching, no parameters" — because every frozen
 * path is a literal and the contract corpus replays literals. A single
 * parameterised route would introduce path parsing into the one component whose
 * simplicity is what guarantees `/api/...` can never be shadowed, and it would
 * need the corpus to learn how to substitute a server-minted id into a URL.
 *
 * A body-carried id costs one thing — an intermediary that strips DELETE bodies
 * would break it — and that failure is safe: an absent id is 400
 * `VALIDATION_FAILED` and deletes nothing. The same reasoning already decided
 * `expectedRevision`; see `optimisticConcurrency`, "Why a body field rather than
 * If-Match".
 */
export const mediaDeleteRequestSchema = z
  .object({ id: mediaAssetIdSchema })
  .strict();

export type MediaDeleteRequest = z.infer<typeof mediaDeleteRequestSchema>;

/**
 * The on-disk catalogue. Authoritative for what the library *contains*.
 *
 * It is a file rather than a SQL table because that is what
 * `docs/hetzner-target-architecture.md` §7 says — "Media is not stored in SQL.
 * SQL may hold upload metadata; bytes stay on disk" — and because the library
 * has exactly the same durability requirement as `draft.json`: one writer, an
 * atomic replacement, and a reader that never sees half a file. Reusing the
 * mechanism that already satisfies that is cheaper and stronger than inventing a
 * second one next to it.
 *
 * It lives outside the document root. Its `assets[].path` values are the only
 * part of it any client ever sees.
 */
export const mediaLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    assets: z.array(mediaAssetMetadataSchema),
  })
  .strict();

export type MediaLibraryIndex = z.infer<typeof mediaLibraryIndexSchema>;

export const MEDIA_LIBRARY_SCHEMA_VERSION = 1;

/**
 * Where bytes live at each stage, and which of those places is web-reachable.
 *
 * One of them is, and it is the last one. `docs/hetzner-target-architecture.md`
 * §7 fixes the layout; this restates it as contract because the *client-visible*
 * consequence — that `assets[].path` is the only server location a response ever
 * names — is a promise to the CMS, not just a deployment convention.
 */
export const mediaStorageLayout = {
  intake: {
    location: "data/media-originals/.intake/",
    webReachable: false,
    note: "Where the multipart part is moved to before anything inspects it. Random name, no extension, unlinked on every exit path.",
  },
  original: {
    location: "data/media-originals/<id>.<ext>",
    webReachable: false,
    note: "The verified upload, kept for re-derivation. Never served, never named in a response.",
  },
  managed: {
    location: "public_html/media/<id>.<ext>",
    webReachable: true,
    note: "The re-encoded derivative. The only artefact of an upload that a URL can reach.",
  },
  requirements: [
    "A byte sequence becomes addressable under /media/ only after it has passed every check in mediaIngest.pipeline.",
    "No response body, error envelope or log line sent to a client names the intake or original path.",
    "PHP execution is disabled under media/ at the web-server level, so an upload that somehow landed there would still be inert.",
  ],
} as const;

/**
 * The ingest pipeline, in order. The order is the specification.
 *
 * Each step exists because the step before it is insufficient on its own, and
 * running them in a different order would make one of them decorative:
 *
 *  1. **Authenticate, then check the token.** Same order and same reason as
 *     every other admin route — an anonymous caller is told 401, not 403, and an
 *     unauthorised caller never gets to use the image decoder.
 *  2. **Bound the bytes before reading them.** The route limit is applied to the
 *     declared length and to what actually arrived. A file that claims to be
 *     small and is not, or that arrives truncated, is refused before any
 *     inspection.
 *  3. **Move out of the request's temp file into intake.** Outside the document
 *     root, under a random name with no extension.
 *  4. **Detect the type from the bytes.** `finfo` on the file contents. The
 *     upload's `Content-Type` header and its filename are read *only* to be
 *     discarded — a caller controls both, and a check that consults them is a
 *     check an attacker configures.
 *  5. **Confirm the type is on the allowlist.**
 *  6. **Read the image header and bound the dimensions.** `getimagesize()`, and
 *     its reported type must agree with step 4. Disagreement means the file is
 *     two things at once — a polyglot — and is refused rather than resolved.
 *  7. **Require the end of the stream to be present.** Decoders are lenient by
 *     design: libjpeg's error recovery turns a JPEG that was cut off mid-transfer
 *     into a complete image with grey filler, and reports nothing. So truncation
 *     cannot be detected by asking the decoder — it has to be asked of the bytes,
 *     by requiring the format's terminator to be in the file. The terminator must
 *     be *present*, not last: trailing bytes after it are refused by nothing,
 *     because re-encoding has already made them unreachable, and cameras do
 *     append them.
 *  8. **Decode.** A file that survives every check above and still will not
 *     decode is not an image, whatever its magic bytes say.
 *  9. **Re-encode into the canonical format for its type.** This is what makes
 *     the stored bytes the server's own output rather than the caller's input,
 *     and it drops EXIF — including GPS coordinates the subject of a photograph
 *     did not agree to publish — as a consequence of how it works rather than as
 *     a separate stripping step someone could forget.
 * 10. **Finalise.** Original into place, derivative into the document root,
 *     catalogue entry last, and every partial state cleaned up on any failure.
 *
 * Steps 4 and 6 are two independent verifications, not one repeated. `finfo`
 * reads magic bytes; `getimagesize()` parses the image header. Requiring both to
 * agree is what refuses a file crafted to satisfy one of them.
 */
export const mediaIngest = {
  pipeline: [
    "authenticate",
    "csrf",
    "boundBytes",
    "moveToIntake",
    "detectTypeFromBytes",
    "assertAllowlisted",
    "boundDimensions",
    "assertStreamIsComplete",
    "decode",
    "reencode",
    "finalise",
  ],
  fieldName: MEDIA_UPLOAD_FIELD_NAME,
  contentType: MEDIA_UPLOAD_CONTENT_TYPE,
  limitBytes: MEDIA_UPLOAD_LIMIT_BYTES,
  formats: mediaFormats,
  requirements: [
    "The declared Content-Type of the part and the client filename never influence acceptance, the stored type or the stored name.",
    "The stored extension is derived from the verified type through `mediaFormats`, so a filename can express no extension at all.",
    "The stored name is `<id>.<ext>` with a cryptographically random id, so two uploads never collide and no name is guessable.",
    "A request carrying no file part, more than one part, or a part under a different name is 400 VALIDATION_FAILED.",
    "A file over the route limit is 413 PAYLOAD_TOO_LARGE and is never inspected, decoded or stored.",
    "A file whose detected type is not on the allowlist is 400 VALIDATION_FAILED, whatever it is named or declared as.",
    "A file whose header type and magic-byte type disagree is 400 VALIDATION_FAILED.",
    "A file missing its format's end-of-stream marker is 400 VALIDATION_FAILED: truncation is detected from the bytes, because decoders recover from it silently.",
    "Bytes after the end-of-stream marker are not a refusal. Re-encoding already makes them unreachable, and refusing them would reject photographs real cameras produce.",
    "A file that survives every check and still will not decode is 400 VALIDATION_FAILED, and nothing reaches the document root.",
    "Every rejection leaves no intake file, no temp file, no original and no file under /media/.",
    "The response body carries only mediaAssetMetadata; no server path, temp name or decoder detail appears in it or in an error envelope.",
    "An environment without the image extensions the pipeline needs answers 500 INVALID_CONFIGURATION rather than accepting an unverified file.",
    "A part PHP refused for a host reason — no usable temporary directory, an unwritable destination or an extension abort — answers the opaque generic 500, is logged at error level and never as VALIDATION_FAILED; an unrecognised non-zero upload error code fails closed the same way (ESZ-135). No PHP error number, path, ini value, extension or temporary name reaches the response.",
  ],
} as const;

/** Uploading (ESZ-036). */
export const mediaUploadOutcome = {
  status: 201,
  body: "media-upload-response.schema.json",
  cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
  requirements: [
    "201, not 200: the request created a resource that did not exist and the body names it.",
    "The stored asset is the re-encoded derivative; `mimeType`, `width`, `height` and `byteSize` describe what is on disk, not what was uploaded.",
    "An absent, unknown, expired or destroyed session is 401 UNAUTHENTICATED and no byte is read.",
    "A missing, empty or wrong CSRF token is 403 CSRF_TOKEN_INVALID and no byte is read.",
    "Uploading does not touch draft.json or published.json. The library and the content document are separate, and pointing at an asset is a content edit the editor makes afterwards.",
  ],
} as const;

/** Listing (ESZ-037). */
export const mediaListOutcome = {
  status: 200,
  body: "media-library-response.schema.json",
  cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
  order: "uploadedAt descending, then id descending, so the list is total and stable",
  requirements: [
    "Authenticated, and `no-store` like every other admin response: an asset list is a map of unpublished editorial work.",
    "Every entry is a validated mediaAssetMetadata read from the catalogue; nothing is inferred from a directory listing.",
    "An absent, unknown, expired or destroyed session is 401 UNAUTHENTICATED with no hint that a library exists.",
    "Reading the library takes no content lock and never seeds, reads or writes draft.json or published.json.",
  ],
} as const;

/**
 * Deleting (ESZ-037), and the one rule that makes it safe.
 *
 * A delete is refused while **either** the authoritative draft or the published
 * document still points at the asset. Both, not just the draft: an asset removed
 * from the draft is still on the live site until someone publishes, and deleting
 * it would break the public page for every visitor while the CMS showed nothing
 * wrong. Checking only the published document is the mirror failure — it would
 * let an editor delete the image their unsaved layout depends on.
 *
 * ## Nothing is ever deleted implicitly
 *
 * Changing a `MediaAsset.src` to point somewhere else does **not** delete what it
 * used to point at, and this endpoint is the only thing in the system that
 * removes bytes. The alternative — reference-counting on save, and cleaning up
 * what fell to zero — is how a single mistaken edit becomes an unrecoverable
 * one, and it is exactly wrong for a CMS where the same photograph is routinely
 * pointed at, unpointed and pointed at again while a page is being arranged.
 * Unreferenced assets simply accumulate; a human removes them deliberately.
 *
 * ## Fail-safe, in both directions
 *
 * An id that does not match `MEDIA_ASSET_ID_PATTERN` never reaches the library:
 * it fails the request schema and is 400 `VALIDATION_FAILED`, like any other
 * malformed body on this surface. That is what keeps the pattern load-bearing
 * rather than decorative — a path fragment or a traversal sequence is refused by
 * the schema, so no filesystem call ever has to survive one. A well-formed id
 * that names nothing is 404 `NOT_FOUND`, which is a different fact and gets a
 * different answer.
 *
 * Collapsing the two into one status would buy nothing: the id space is 128 bits
 * of CSPRNG output, the route is authenticated, and the caller already knows
 * whether the id it sent was well-formed. What it would cost is the ability to
 * tell a client bug from a stale reference.
 *
 * A catalogue entry whose file is already gone still deletes cleanly, so a
 * disagreement between disk and catalogue can be resolved rather than becoming
 * permanently undeletable. A file that is present but whose entry is absent is
 * not addressable through this API at all and is never removed by it.
 */
export const mediaDeleteOutcome = {
  status: 204,
  body: "empty",
  cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
  referenceCheck: "the authoritative draft and the published document, both read before anything is removed",
  refusal: { status: 409, errorCode: "MEDIA_REFERENCED" },
  requirements: [
    "204 with no body on success; the asset, its original and its catalogue entry are all gone.",
    "A referenced asset is 409 MEDIA_REFERENCED and nothing is removed: not the file, not the original, not the entry.",
    "The reference check covers every MediaAsset.src in both documents, compared against the asset's public path.",
    "A well-formed id that names no catalogued asset is 404 NOT_FOUND.",
    "An id that does not match the frozen pattern is 400 VALIDATION_FAILED from the request schema, and never reaches a filesystem call.",
    "A missing or non-string id is 400 VALIDATION_FAILED.",
    "Every media response carries Cache-Control: no-store, errors included.",
    "Deleting never modifies draft.json or published.json, and never moves either revision.",
    "The response names no filesystem path, in success or in refusal.",
  ],
} as const;

/**
 * Managed-reference integrity for content writes (ESZ-147).
 *
 * `MediaAsset.src` accepts any contract-valid public path plus absolute
 * HTTP(S) URLs. The *managed* namespace is the one the server controls —
 * values matching `MEDIA_PUBLIC_PATH_PATTERN` — and a document that names a
 * managed path the catalogue does not carry would render a broken image that
 * no editor can tell apart from a working one until it is too late. Every
 * content write that can make such a reference durable therefore verifies,
 * under the ESZ-100 media/content boundary, that each managed `src` it is
 * about to persist **exactly equals** a catalogued public path.
 *
 * ## Enforcement points and outcomes
 *
 *  - **Draft save** (`PUT /api/admin/content/draft`): the *submitted*
 *    document's managed src values are checked against the catalogue before
 *    the write, inside the same shared boundary acquisition that spans the
 *    whole commit. A managed path with no catalogue entry is 400
 *    `VALIDATION_FAILED` — the caller sent a document nothing in the library
 *    can satisfy — and no write happens and no revision moves.
 *  - **Publish** (`POST /api/admin/content/publish`): the *stored* draft is
 *    the document under test, re-read under the exclusive lock. A stored
 *    draft whose managed src values no longer resolve is a fault of the
 *    service rather than of the caller, and answers 500 `STORAGE_FAILURE`
 *    with `published.json` byte-identical.
 *
 * Nothing else changes: HTTP(S) URLs, non-managed public paths and `null`
 * stay valid, and a src that does not match the managed pattern is by
 * definition outside this rule. Membership is decided by exact path
 * comparison against the catalogue (`media-library.json`), which is
 * authoritative; the filesystem is never probed, because bytes and catalogue
 * entries can disagree and the catalogue is the record that decides what may
 * be referenced. No new public error code is introduced: the two outcomes
 * reuse `VALIDATION_FAILED` and `STORAGE_FAILURE`.
 */
export const mediaReferenceIntegrity = {
  scope:
    "every managed MediaAsset.src a content write persists — string values matching MEDIA_PUBLIC_PATH_PATTERN",
  invariant:
    "a managed src becomes durable only when it exactly equals a catalogued public path at commit time",
  compareBy: "exact public path, never the id alone: a valid id under the wrong path or extension is a different string and fails",
  authority:
    "the media catalogue (media-library.json), read under the shared ESZ-100 boundary; never a filesystem probe",
  outsideThisRule: [
    "absolute HTTP(S) URLs",
    "public paths that do not match MEDIA_PUBLIC_PATH_PATTERN",
    "null",
  ],
  boundary:
    "the check runs inside the media-content boundary acquisition the write already holds shared across its whole commit, so a delete holding that boundary exclusively can never land between the check and the write",
  enforcement: [
    {
      operation: "draft save",
      route: `PUT ${ADMIN_CONTENT_DRAFT_PATH}`,
      checkedDocument: "the submitted content, before the write",
      outcome: "400 VALIDATION_FAILED; no write, no revision bump",
    },
    {
      operation: "publish",
      route: `POST ${ADMIN_CONTENT_PUBLISH_PATH}`,
      checkedDocument: "the stored draft, re-read under the exclusive lock",
      outcome: "500 STORAGE_FAILURE; published.json readable and byte-identical",
    },
  ],
} as const;

/**
 * The frozen French error messages. They are part of the contract because the
 * frontend and future PHP implementation must not diverge on user-facing copy.
 */
export const apiErrorMessages: Record<ApiErrorCode, string> = {
  NOT_FOUND: "La ressource demandée est introuvable.",
  METHOD_NOT_ALLOWED: "Méthode non autorisée pour cette ressource.",
  INVALID_JSON: "Le corps JSON est invalide.",
  VALIDATION_FAILED: "Les données envoyées sont invalides.",
  INVALID_CREDENTIALS: "Identifiants invalides.",
  UNAUTHENTICATED: "Authentification requise.",
  CSRF_TOKEN_INVALID: "Jeton de sécurité invalide ou expiré.",
  REVISION_CONFLICT:
    "La ressource a été modifiée entre-temps. Rechargez son état avant d'enregistrer.",
  PAYLOAD_TOO_LARGE:
    "Le fichier envoyé dépasse la taille maximale autorisée de 8 Mo.",
  MEDIA_REFERENCED:
    "Ce média est utilisé par le brouillon ou par le site publié. Retirez-le du contenu avant de le supprimer.",
  SLOT_UNAVAILABLE:
    "Ce créneau n’est plus disponible. Choisissez un autre horaire.",
  RATE_LIMITED:
    "Trop de tentatives. Merci de patienter quelques instants avant de réessayer.",
  INVALID_CONFIGURATION: "La configuration du serveur est invalide.",
  STORAGE_FAILURE: "Le contenu publié est momentanément indisponible.",
  INTERNAL_ERROR: "Une erreur interne est survenue.",
};

/**
 * Body matchers used by the executable contract corpus. Values that are
 * non-deterministic by nature (timestamps, uptime, generated ids) are asserted
 * through these matchers instead of literal golden values.
 */
export const contractBodyMatchers = [
  "healthResponse",
  "publishedContentEnvelope",
  "serverDraftEnvelope",
  "errorEnvelope",
  "publicPageHtml",
  "authSessionResponse",
  "mediaLibraryResponse",
  "mediaUploadResponse",
  "publicBookableServicesResponse",
  "bookingAvailabilityResponse",
  "publicBookingResponse",
  "adminBookingsResponse",
  "adminBookingResponse",
  "adminBookingReferenceResponse",
  "adminBookingsSummaryResponse",
  "adminAvailabilityResponse",
  "adminAvailabilityWeeklyResponse",
  "adminAvailabilityExceptionResponse",
  "empty",
] as const;

export type ContractBodyMatcher = (typeof contractBodyMatchers)[number];

/**
 * Request bodies the runner *builds* rather than reads literally from the
 * artifact.
 *
 * A valid `SiteContent` is roughly 8 kB of JSON. Writing several of them into
 * `http-contract.json` as literals would multiply the size of a file every
 * implementation has to parse, to assert one number in each — the same reason
 * `body.overLimitRejected` is an invariant with a computed body rather than a
 * 64 kB literal case. So a case names a body, and the runner constructs it from
 * the canonical document it already has.
 *
 * The named bodies are exhaustive and closed, so a runner that does not
 * recognise one fails loudly instead of sending nothing.
 */
export const contractRequestBodies = [
  /** `expectedRevision: 0`, canonical content. Valid against a freshly seeded draft. */
  "draftSave.valid",
  /** Canonical content, but a revision no freshly seeded draft can be at. */
  "draftSave.staleRevision",
  /** `expectedRevision: 0` with content that fails a semantic rule. */
  "draftSave.semanticallyInvalidContent",
  /** `expectedRevision: 0` with content that fails the structural schema. */
  "draftSave.structurallyInvalidContent",
  /** Well-formed but missing the required `content` key. */
  "draftSave.missingContent",
  /** Well-formed, canonical content, plus a key the schema does not declare. */
  "draftSave.unknownField",
  /** Canonical content with no `expectedRevision` at all. */
  "draftSave.missingExpectedRevision",
  "publish.valid",
  "publish.staleRevision",
  "publish.missingExpectedRevision",
  "reset.valid",
  "reset.staleRevision",
  /** A `source` outside the closed enum. */
  "reset.unknownSource",
  /** No `source` key at all. */
  "reset.missingSource",
  /** A well-formed id that no catalogue entry can carry, on a freshly seeded library. */
  "mediaDelete.unknownId",
  /** An id that does not match `MEDIA_ASSET_ID_PATTERN` at all. */
  "mediaDelete.malformedId",
  /** An id shaped like a traversal attempt, to prove the pattern is what decides. */
  "mediaDelete.traversalId",
  /** Well-formed JSON object with no `id` key. */
  "mediaDelete.missingId",
] as const;

export type ContractRequestBody = (typeof contractRequestBodies)[number];

/**
 * The revision a `*.staleRevision` body claims.
 *
 * Any value a freshly seeded deployment cannot be at would do; naming it here
 * means the runner and the assertion cannot drift apart on which one it is.
 */
export const STALE_REVISION_FIXTURE = 4242;

/**
 * The id `mediaDelete.unknownId` sends: well-formed, and belonging to nothing.
 *
 * Fixed rather than random so the case is deterministic, and all-`f` so it is
 * obviously a fixture in a log line. A freshly seeded library is empty, so any
 * well-formed id is unknown there; naming this one means the runner and the
 * assertion cannot disagree about which id was sent.
 */
export const UNKNOWN_MEDIA_ID_FIXTURE = "med_" + "f".repeat(32);

/** How the response `X-Request-Id` relates to the request. */
export const requestIdExpectations = ["echoesRequest", "generated"] as const;

export type RequestIdExpectation = (typeof requestIdExpectations)[number];

/**
 * Implementations the contract is executed against.
 *
 * Just PHP since ESZ-015. The Express reference service was retired once it and
 * the PHP front controller both replayed this artifact green — two
 * implementations of a frozen surface are worth maintaining while one is being
 * migrated onto the other, and dead weight afterwards. The exemption mechanism
 * below outlives it: it is now the record of where the target host's shape
 * differs from what the surface originally assumed.
 */
export const contractImplementations = ["php"] as const;

export type ContractImplementation = (typeof contractImplementations)[number];

/**
 * A case one implementation is not required to satisfy, and why.
 *
 * This exists so a migration difference and a regression cannot look alike. A
 * skipped test proves nothing and reads as an oversight; an exemption is data,
 * carried in the generated artifact, and the runner reports it as an intentional
 * difference. Adding one is a contract change and should be rare.
 */
export interface ContractExemption {
  implementation: ContractImplementation;
  reason: string;
}

export interface HttpContractCase {
  /** Stable identifier, safe to reference from a PHP test suite. */
  id: string;
  endpoint:
    | "/api/health"
    | "/api/content"
    | "/"
    | "/api/auth/login"
    | "/api/auth/logout"
    | "/api/auth/session"
    | "/api/admin/content/draft"
    | "/api/admin/content/publish"
    | "/api/admin/content/reset"
    | "/api/admin/media"
    | "/api/booking/availability"
    | "/api/booking/services"
    | "/api/bookings"
    | "/api/admin/bookings/query"
    | "/api/admin/bookings/move-availability"
    | "/api/admin/bookings"
    | "/api/admin/bookings/summary"
    | "/api/admin/availability/query"
    | "/api/admin/availability/weekly"
    | "/api/admin/availability/exceptions"
    | "unknown";
  description: string;
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    /** Raw body sent verbatim; used to exercise malformed JSON handling. */
    rawBody?: string;
    /**
     * A body the runner builds from {@link contractRequestBodies} instead of
     * carrying it literally. Mutually exclusive with `rawBody`.
     */
    body?: ContractRequestBody;
  };
  expect: {
    status: number;
    body: ContractBodyMatcher;
    /** Required only when `body` is `errorEnvelope`. */
    errorCode?: ApiErrorCode;
    /** Headers compared literally. */
    headers?: Record<string, string>;
    /**
     * Headers that must NOT match a pattern. Used instead of "header absent"
     * where a framework may legitimately add its own value: Express, for
     * example, attaches a weak ETag to error bodies. What the contract
     * actually requires is that no error response ever carries a *published*
     * content validator.
     */
    forbiddenHeaderPatterns?: Record<string, string>;
    /** Headers matched against a regular expression source. */
    headerPatterns?: Record<string, string>;
    requestId?: RequestIdExpectation;
    /**
     * Which document the public page must have rendered. Only meaningful when
     * `body` is `publicPageHtml`: `published` means the injected envelope reached
     * the HTML, `defaults` means the fallback of `publicPageFallbackOutcome` did.
     */
    pageContent?: "published" | "defaults";
    /**
     * Value `authenticated` must carry. Only meaningful when `body` is
     * `authSessionResponse`.
     */
    authenticated?: boolean;
    /**
     * Assertions on the session cookie the response sets. `rotated` requires a
     * `Set-Cookie` carrying an id different from the one the request sent;
     * `cleared` requires one that expires it; `absent` requires none at all.
     */
    sessionCookie?: "rotated" | "cleared" | "absent";
    /**
     * What `x-content-revision` must report. A number is compared literally;
     * `absent` requires the header not to be sent at all, which is what proves a
     * 401 or a 403 never reached storage.
     */
    contentRevision?: number | "absent";
    /**
     * Assertion on stored content after the request, for the routes that write.
     * `unchanged` requires both envelopes to be byte-identical to what they were
     * before the request — the check that makes "a conflict writes nothing" and
     * "reset never touches published" testable rather than merely stated.
     */
    storageAfter?: "unchanged" | "draftAdvanced" | "publishedMatchesDraft";
  };
  /**
   * Published envelope revision the fixture server must serve. Omitted when
   * the case does not depend on stored content.
   */
  publishedRevision?: number;
  /** Storage behaviour the fixture server must simulate. */
  storage?: "ok" | "failure" | "malformed";
  /**
   * Preconditions for the authenticated surface (ESZ-025/026).
   *
   * Stated as fixture *state* rather than as literal headers because neither a
   * session id nor a CSRF token can be written down in advance — both are minted
   * by the implementation under test. The runner establishes the named state,
   * reads the values back out of the implementation, and puts them on the
   * request. `csrf: "valid"` therefore means "the token this session actually
   * holds", which is the only way to assert acceptance without weakening the
   * check to a constant.
   */
  auth?: {
    /** Session the request arrives with. Defaults to `none`. */
    session?: "none" | "anonymous" | "authenticated";
    /** What goes in the CSRF header. Defaults to `omitted`. */
    csrf?: "valid" | "omitted" | "empty" | "wrong";
    /** State of the account the login body addresses. */
    account?: "enabled" | "disabled" | "missing";
  };
  /**
   * Implementations that are not required to satisfy this case. Absent — the
   * normal state — means every implementation must.
   */
  exemptions?: ContractExemption[];
}

const jsonContentType = { "content-type": "application/json; charset=utf-8" };

/**
 * The executable freeze. Every case is deterministic and machine-runnable
 * against any implementation of the contract, Node or otherwise.
 */
export const httpContractCases: HttpContractCase[] = [
  {
    id: "health.get.ok",
    endpoint: "/api/health",
    description: "GET /api/health returns the frozen health payload.",
    request: { method: "GET", path: "/api/health" },
    expect: {
      status: 200,
      body: "healthResponse",
      headers: jsonContentType,
      headerPatterns: { "x-request-id": `^${REQUEST_ID_PREFIX}` },
      requestId: "generated",
    },
  },
  {
    id: "health.get.echoesSafeRequestId",
    endpoint: "/api/health",
    description: "A safe inbound X-Request-Id is preserved verbatim.",
    request: {
      method: "GET",
      path: "/api/health",
      headers: { "x-request-id": "req_contract-safe.id:1" },
    },
    expect: {
      status: 200,
      body: "healthResponse",
      headers: { "x-request-id": "req_contract-safe.id:1" },
      requestId: "echoesRequest",
    },
  },
  {
    id: "health.get.replacesUnsafeRequestId",
    endpoint: "/api/health",
    description: "An unsafe inbound X-Request-Id is replaced by a generated one.",
    request: {
      method: "GET",
      path: "/api/health",
      headers: { "x-request-id": "../unsafe request id" },
    },
    expect: {
      status: 200,
      body: "healthResponse",
      headerPatterns: { "x-request-id": `^${REQUEST_ID_PREFIX}` },
      requestId: "generated",
    },
  },
  {
    id: "health.post.methodNotAllowed",
    endpoint: "/api/health",
    description: "Non-GET methods on /api/health return 405 with Allow: GET.",
    request: { method: "POST", path: "/api/health" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET", ...jsonContentType },
    },
  },
  {
    id: "health.delete.methodNotAllowed",
    endpoint: "/api/health",
    description: "DELETE on /api/health returns 405 with Allow: GET.",
    request: { method: "DELETE", path: "/api/health" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET" },
    },
  },
  {
    id: "health.post.invalidJson",
    endpoint: "/api/health",
    description:
      "A malformed JSON body is rejected with 400 before method handling.",
    request: {
      method: "POST",
      path: "/api/health",
      headers: { "content-type": "application/json" },
      rawBody: "{invalid-json",
    },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "INVALID_JSON",
    },
  },
  {
    id: "content.get.ok",
    endpoint: "/api/content",
    description:
      "GET /api/content returns the published envelope with ETag and Cache-Control.",
    request: { method: "GET", path: "/api/content" },
    publishedRevision: 12,
    storage: "ok",
    expect: {
      status: 200,
      body: "publishedContentEnvelope",
      headers: {
        etag: '"published-12"',
        "cache-control": CONTENT_CACHE_CONTROL,
        ...jsonContentType,
      },
    },
  },
  {
    id: "content.get.revisionZeroEtag",
    endpoint: "/api/content",
    description: "Revision 0 produces a stable ETag rather than an empty one.",
    request: { method: "GET", path: "/api/content" },
    publishedRevision: 0,
    storage: "ok",
    expect: {
      status: 200,
      body: "publishedContentEnvelope",
      headers: { etag: '"published-0"', "cache-control": CONTENT_CACHE_CONTROL },
    },
  },
  {
    id: "content.get.ifNoneMatch.hit",
    endpoint: "/api/content",
    description: "A matching If-None-Match yields an empty 304 that keeps caching headers.",
    request: {
      method: "GET",
      path: "/api/content",
      headers: { "if-none-match": '"published-8"' },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: {
      status: 304,
      body: "empty",
      headers: { etag: '"published-8"', "cache-control": CONTENT_CACHE_CONTROL },
    },
  },
  {
    id: "content.get.ifNoneMatch.stale",
    endpoint: "/api/content",
    description: "A stale If-None-Match revalidates with a full 200.",
    request: {
      method: "GET",
      path: "/api/content",
      headers: { "if-none-match": '"published-7"' },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: {
      status: 200,
      body: "publishedContentEnvelope",
      headers: { etag: '"published-8"' },
    },
  },
  {
    id: "content.get.ifNoneMatch.list",
    endpoint: "/api/content",
    description: "A comma-separated If-None-Match list matches on any member.",
    request: {
      method: "GET",
      path: "/api/content",
      headers: { "if-none-match": '"other", "published-8"' },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: { status: 304, body: "empty" },
  },
  {
    id: "content.get.ifNoneMatch.wildcard",
    endpoint: "/api/content",
    description: "If-None-Match: * always yields 304.",
    request: {
      method: "GET",
      path: "/api/content",
      headers: { "if-none-match": "*" },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: { status: 304, body: "empty" },
  },
  {
    id: "content.get.ifNoneMatch.malformed",
    endpoint: "/api/content",
    description: "A malformed If-None-Match is ignored and yields 200.",
    request: {
      method: "GET",
      path: "/api/content",
      headers: { "if-none-match": "not an etag" },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: { status: 200, body: "publishedContentEnvelope" },
  },
  {
    id: "content.get.storageFailure",
    endpoint: "/api/content",
    description:
      "A storage failure returns an opaque 500 that leaks no path or schema detail.",
    request: { method: "GET", path: "/api/content" },
    storage: "failure",
    expect: {
      status: 500,
      body: "errorEnvelope",
      errorCode: "STORAGE_FAILURE",
      forbiddenHeaderPatterns: { etag: PUBLISHED_ETAG_PATTERN },
    },
  },
  {
    id: "content.get.malformedStoredEnvelope",
    endpoint: "/api/content",
    description:
      "A stored envelope failing schema validation is reported as the same opaque 500.",
    request: { method: "GET", path: "/api/content" },
    storage: "malformed",
    expect: {
      status: 500,
      body: "errorEnvelope",
      errorCode: "STORAGE_FAILURE",
      forbiddenHeaderPatterns: { etag: PUBLISHED_ETAG_PATTERN },
    },
  },
  {
    id: "content.post.methodNotAllowed",
    endpoint: "/api/content",
    description: "Non-GET methods on /api/content return 405 with Allow: GET.",
    request: { method: "POST", path: "/api/content" },
    storage: "ok",
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET" },
    },
  },
  {
    id: "content.put.methodNotAllowed",
    endpoint: "/api/content",
    description: "PUT on /api/content returns 405 rather than 404.",
    request: { method: "PUT", path: "/api/content" },
    storage: "ok",
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET" },
    },
  },
  {
    id: "unknown.get.notFound",
    endpoint: "unknown",
    description: "Unknown routes return a structured JSON 404.",
    request: { method: "GET", path: "/api/unknown" },
    expect: {
      status: 404,
      body: "errorEnvelope",
      errorCode: "NOT_FOUND",
      headers: jsonContentType,
    },
  },
  {
    id: "page.get.ok",
    endpoint: "/",
    description:
      "GET / serves the exported HTML with the published content injected, under the same ETag and Cache-Control as GET /api/content.",
    request: { method: "GET", path: "/" },
    publishedRevision: 12,
    storage: "ok",
    expect: {
      status: 200,
      body: "publicPageHtml",
      pageContent: "published",
      headers: {
        etag: '"published-12"',
        "cache-control": CONTENT_CACHE_CONTROL,
        "content-type": PUBLIC_PAGE_CONTENT_TYPE,
      },
    },
  },
  {
    id: "page.get.ifNoneMatch.hit",
    endpoint: "/",
    description:
      "A matching If-None-Match on / yields an empty 304, exactly as on /api/content.",
    request: {
      method: "GET",
      path: "/",
      headers: { "if-none-match": '"published-8"' },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: {
      status: 304,
      body: "empty",
      headers: { etag: '"published-8"', "cache-control": CONTENT_CACHE_CONTROL },
    },
  },
  {
    id: "page.get.ifNoneMatch.stale",
    endpoint: "/",
    description: "A stale If-None-Match on / revalidates with a full 200.",
    request: {
      method: "GET",
      path: "/",
      headers: { "if-none-match": '"published-7"' },
    },
    publishedRevision: 8,
    storage: "ok",
    expect: {
      status: 200,
      body: "publicPageHtml",
      pageContent: "published",
      headers: { etag: '"published-8"' },
    },
  },
  {
    id: "page.head.ok",
    endpoint: "/",
    description:
      "HEAD / answers the GET headers with no body. The page is a document a crawler or monitor will probe with HEAD, so unlike the JSON surface it does not 405.",
    request: { method: "HEAD", path: "/" },
    publishedRevision: 12,
    storage: "ok",
    expect: {
      status: 200,
      body: "empty",
      headers: {
        etag: '"published-12"',
        "cache-control": CONTENT_CACHE_CONTROL,
        "content-type": PUBLIC_PAGE_CONTENT_TYPE,
      },
    },
  },
  {
    id: "page.get.storageFailure",
    endpoint: "/",
    description:
      "A storage failure serves the exported defaults with 200 and no published ETag, never an error page.",
    request: { method: "GET", path: "/" },
    storage: "failure",
    expect: {
      status: 200,
      body: "publicPageHtml",
      pageContent: "defaults",
      headers: { "content-type": PUBLIC_PAGE_CONTENT_TYPE },
      forbiddenHeaderPatterns: { etag: PUBLISHED_ETAG_PATTERN },
    },
  },
  {
    id: "page.get.malformedStoredEnvelope",
    endpoint: "/",
    description:
      "A stored envelope failing validation degrades the page the same way a read failure does.",
    request: { method: "GET", path: "/" },
    storage: "malformed",
    expect: {
      status: 200,
      body: "publicPageHtml",
      pageContent: "defaults",
      forbiddenHeaderPatterns: { etag: PUBLISHED_ETAG_PATTERN },
    },
  },
  {
    id: "page.post.methodNotAllowed",
    endpoint: "/",
    description: "Writing methods on / return 405 with Allow: GET, HEAD.",
    request: { method: "POST", path: "/" },
    storage: "ok",
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET, HEAD", ...jsonContentType },
    },
  },

  // ── Authenticated surface (ESZ-025 / ESZ-026) ──────────────────────────────
  //
  // These paths were frozen at 404 until Package 2.2. They are contracted here
  // *before* the PHP routes exist, which is the ordering `docs/hetzner-target-
  // architecture.md` §6 requires: the contract is the source of truth, not a
  // description written after the fact.

  {
    id: "auth.session.get.anonymous",
    endpoint: AUTH_SESSION_PATH,
    description:
      "GET /api/auth/session with no session answers 200, not 401: it reports state, it does not require it. The anonymous session it opens is what carries the CSRF token a login will need.",
    request: { method: "GET", path: AUTH_SESSION_PATH },
    auth: { session: "none" },
    expect: {
      status: 200,
      body: "authSessionResponse",
      authenticated: false,
      headers: jsonContentType,
    },
  },
  {
    id: "auth.session.get.authenticated",
    endpoint: AUTH_SESSION_PATH,
    description: "GET /api/auth/session with a live session reports the signed-in account.",
    request: { method: "GET", path: AUTH_SESSION_PATH },
    auth: { session: "authenticated" },
    expect: { status: 200, body: "authSessionResponse", authenticated: true },
  },
  {
    id: "auth.session.get.unknownSessionIdIsAnonymous",
    endpoint: AUTH_SESSION_PATH,
    description:
      "A session cookie whose id has no server-side record is anonymous, and the supplied id is never adopted. This is the session-fixation floor: an attacker cannot choose the victim's id in advance.",
    request: {
      method: "GET",
      path: AUTH_SESSION_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=0123456789abcdef0123456789abcdef` },
    },
    auth: { session: "none" },
    expect: { status: 200, body: "authSessionResponse", authenticated: false },
  },
  {
    id: "auth.session.post.methodNotAllowed",
    endpoint: AUTH_SESSION_PATH,
    description: "Non-GET on /api/auth/session returns 405 with Allow: GET.",
    request: { method: "POST", path: AUTH_SESSION_PATH },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET", ...jsonContentType },
    },
  },
  {
    id: "auth.login.post.ok",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "A correct credential pair with a valid CSRF token signs in, rotates the session id and returns the same body shape GET /api/auth/session returns.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "enabled" },
    expect: {
      status: 200,
      body: "authSessionResponse",
      authenticated: true,
      sessionCookie: "rotated",
      headers: jsonContentType,
    },
  },
  {
    id: "auth.login.post.unknownEmail",
    endpoint: AUTH_LOGIN_PATH,
    description: "An address with no account fails as INVALID_CREDENTIALS.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"nobody@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "missing" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "INVALID_CREDENTIALS",
      sessionCookie: "absent",
    },
  },
  {
    id: "auth.login.post.wrongPassword",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "A known address with the wrong password fails identically to an unknown one.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"not-the-password"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "enabled" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "INVALID_CREDENTIALS",
      sessionCookie: "absent",
    },
  },
  {
    id: "auth.login.post.disabledAccount",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "A disabled account with the *correct* password fails identically again. Disabling is enforced here, not by hoping nobody knows the password.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "disabled" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "INVALID_CREDENTIALS",
      sessionCookie: "absent",
    },
  },
  {
    id: "auth.login.post.csrfOmitted",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "Login without a CSRF token is refused with 403 even when the credentials are correct, which is what closes login CSRF.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      sessionCookie: "absent",
    },
  },
  {
    id: "auth.login.post.csrfWrong",
    endpoint: AUTH_LOGIN_PATH,
    description: "A well-formed token belonging to no session is refused the same way.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "wrong", account: "enabled" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
  {
    id: "auth.login.post.csrfEmpty",
    endpoint: AUTH_LOGIN_PATH,
    description: "An empty token is refused, not treated as absent-and-therefore-skipped.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test","password":"correct-horse-battery"}',
    },
    auth: { session: "anonymous", csrf: "empty", account: "enabled" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
  {
    id: "auth.login.post.missingField",
    endpoint: AUTH_LOGIN_PATH,
    description: "A body missing `password` is 400 VALIDATION_FAILED, not 401.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"email":"editor@example.test"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "auth.login.post.unknownField",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "The login body is closed: an unexpected key is rejected rather than ignored.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"email":"editor@example.test","password":"correct-horse-battery","role":"admin"}',
    },
    auth: { session: "anonymous", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "auth.login.post.invalidJson",
    endpoint: AUTH_LOGIN_PATH,
    description:
      "A malformed body is still the pre-routing 400 INVALID_JSON, decided before CSRF or credentials.",
    request: {
      method: "POST",
      path: AUTH_LOGIN_PATH,
      headers: { "content-type": "application/json" },
      rawBody: "{invalid-json",
    },
    auth: { session: "anonymous", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "INVALID_JSON" },
  },
  {
    id: "auth.login.get.methodNotAllowed",
    endpoint: AUTH_LOGIN_PATH,
    description: "GET /api/auth/login returns 405 with Allow: POST.",
    request: { method: "GET", path: AUTH_LOGIN_PATH },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "POST", ...jsonContentType },
    },
  },
  {
    id: "auth.logout.post.ok",
    endpoint: AUTH_LOGOUT_PATH,
    description:
      "Logout answers 204 with no body, destroys the server-side record and expires the cookie.",
    request: { method: "POST", path: AUTH_LOGOUT_PATH },
    auth: { session: "authenticated", csrf: "valid" },
    expect: { status: 204, body: "empty", sessionCookie: "cleared" },
  },
  {
    id: "auth.logout.post.unauthenticated",
    endpoint: AUTH_LOGOUT_PATH,
    description:
      "Logout without a session is 401 UNAUTHENTICATED. Authentication is resolved before CSRF, so a caller with neither is told the useful thing.",
    request: { method: "POST", path: AUTH_LOGOUT_PATH },
    auth: { session: "none", csrf: "omitted" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "auth.logout.post.csrfOmitted",
    endpoint: AUTH_LOGOUT_PATH,
    description:
      "An authenticated logout without a CSRF token is 403 and leaves the session alive.",
    request: { method: "POST", path: AUTH_LOGOUT_PATH },
    auth: { session: "authenticated", csrf: "omitted" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      sessionCookie: "absent",
    },
  },
  {
    id: "auth.logout.post.csrfWrong",
    endpoint: AUTH_LOGOUT_PATH,
    description: "An authenticated logout with someone else's token is 403.",
    request: { method: "POST", path: AUTH_LOGOUT_PATH },
    auth: { session: "authenticated", csrf: "wrong" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
  {
    id: "auth.logout.get.methodNotAllowed",
    endpoint: AUTH_LOGOUT_PATH,
    description: "GET /api/auth/logout returns 405 with Allow: POST.",
    request: { method: "GET", path: AUTH_LOGOUT_PATH },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "POST", ...jsonContentType },
    },
  },

  // ── /api/admin/content/* (Package 3.1) ──────────────────────────────────
  //
  // Every case below runs against a *freshly seeded* deployment, so the draft
  // head is 0 and the published revision is 0. That is what lets the corpus
  // assert concurrency outcomes with literal numbers and no fixture state: a
  // body naming revision 0 is current, one naming STALE_REVISION_FIXTURE is not.

  {
    id: "admin.draft.get.ok",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "An authenticated GET returns the stored draft envelope, uncacheable, with the revision header.",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 200,
      body: "serverDraftEnvelope",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL, ...jsonContentType },
      contentRevision: 0,
    },
  },
  {
    id: "admin.draft.get.carriesNoEtag",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "The draft offers exactly one revision token. An ETag would be a second, usable as a precondition the surface does not honour.",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 200,
      body: "serverDraftEnvelope",
      forbiddenHeaderPatterns: { etag: "published" },
    },
  },
  {
    id: "admin.draft.get.unauthenticated",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "No session is 401, and the revision header is absent: an anonymous caller learns nothing about stored content.",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "none" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      contentRevision: "absent",
    },
  },
  {
    id: "admin.draft.get.anonymousSessionIsNotAuthenticated",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "An anonymous session — the one that holds a CSRF token — is not partial authentication.",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "anonymous" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.draft.get.disabledAccount",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "A live session whose account has since been disabled is 401 here, not only at the next login.",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "authenticated", account: "disabled" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      contentRevision: "absent",
    },
  },
  {
    id: "admin.draft.get.needsNoCsrfToken",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "A read changes no state and is exempt from the token (`csrf.readsAreExempt`).",
    request: { method: "GET", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "serverDraftEnvelope" },
  },
  {
    id: "admin.draft.delete.methodNotAllowed",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "DELETE on the draft returns 405 with the allowed methods.",
    request: { method: "DELETE", path: ADMIN_CONTENT_DRAFT_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET, PUT", ...jsonContentType },
    },
  },

  {
    id: "admin.draft.put.ok",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "A complete, valid document at the current revision is stored and answered with the new envelope at head + 1.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.valid",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 200,
      body: "serverDraftEnvelope",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL, ...jsonContentType },
      contentRevision: 1,
      storageAfter: "draftAdvanced",
    },
  },
  {
    id: "admin.draft.put.staleRevisionConflicts",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "A save from an editor that has not seen the current head is refused with 409 and writes nothing.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.staleRevision",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 409,
      body: "errorEnvelope",
      errorCode: "REVISION_CONFLICT",
      // The head the caller lost to, so a client can rebase without a second call.
      contentRevision: 0,
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.semanticallyInvalidContent",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "Structural validity is not enough: a document breaking a semantic rule is 400 and is not stored.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.semanticallyInvalidContent",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.structurallyInvalidContent",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "A document failing the JSON Schema is 400 and is not stored.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.structurallyInvalidContent",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.missingContent",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "The body is closed and complete: a save with no `content` is 400, never a partial update.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.missingContent",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.missingExpectedRevision",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "An omitted precondition is a rejected request, never an unconditional write.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.missingExpectedRevision",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.unknownField",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "An undeclared top-level key is rejected rather than ignored.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.unknownField",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.unauthenticated",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "Authentication is resolved before CSRF and before the body: no session is 401 and nothing is validated or written.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.valid",
    },
    auth: { session: "none", csrf: "omitted" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.csrfOmitted",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "An authenticated save with no token is 403 and writes nothing.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.valid",
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.csrfWrong",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description: "A well-formed token belonging to no session is refused the same way.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.valid",
    },
    auth: { session: "authenticated", csrf: "wrong", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.csrfCheckedBeforeValidation",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "A rejected token is 403 even when the body is also invalid, so an unauthorised caller cannot use this route as a validator.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      body: "draftSave.structurallyInvalidContent",
    },
    auth: { session: "authenticated", csrf: "wrong", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.draft.put.invalidJson",
    endpoint: ADMIN_CONTENT_DRAFT_PATH,
    description:
      "A malformed body is the pre-routing 400 INVALID_JSON, decided before auth, CSRF or the schema.",
    request: {
      method: "PUT",
      path: ADMIN_CONTENT_DRAFT_PATH,
      headers: { "content-type": "application/json" },
      rawBody: "{invalid-json",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "INVALID_JSON" },
  },

  {
    id: "admin.publish.post.ok",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description:
      "Publishing answers the new published envelope, whose revision is the draft head that was published.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.valid",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 200,
      body: "publishedContentEnvelope",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL, ...jsonContentType },
      contentRevision: 0,
      storageAfter: "publishedMatchesDraft",
    },
  },
  {
    id: "admin.publish.post.carriesNoPublishedEtag",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description:
      "The publish response is not a cacheable representation of the published document; only `/` and /api/content mint that validator.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.valid",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 200,
      body: "publishedContentEnvelope",
      forbiddenHeaderPatterns: { etag: "published" },
      storageAfter: "publishedMatchesDraft",
    },
  },
  {
    id: "admin.publish.post.staleRevisionConflicts",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description:
      "Publishing against a draft head the caller has not seen is 409, and published content is untouched.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.staleRevision",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 409,
      body: "errorEnvelope",
      errorCode: "REVISION_CONFLICT",
      contentRevision: 0,
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.publish.post.missingExpectedRevision",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description: "Publish carries the same required precondition as a save.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.missingExpectedRevision",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.publish.post.unauthenticated",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description: "No session is 401, and nothing is published.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.valid",
    },
    auth: { session: "none", csrf: "omitted" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.publish.post.csrfOmitted",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description: "An authenticated publish with no token is 403 and publishes nothing.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_PUBLISH_PATH,
      headers: { "content-type": "application/json" },
      body: "publish.valid",
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.publish.get.methodNotAllowed",
    endpoint: ADMIN_CONTENT_PUBLISH_PATH,
    description: "Publishing is not a safe method; GET returns 405 with Allow: POST.",
    request: { method: "GET", path: ADMIN_CONTENT_PUBLISH_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "POST", ...jsonContentType },
    },
  },

  {
    id: "admin.reset.post.ok",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description:
      "Resetting from published rebuilds the draft at the next revision and answers the new draft envelope.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.valid",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 200,
      body: "serverDraftEnvelope",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL, ...jsonContentType },
      contentRevision: 1,
      // Published is deliberately absent from this expectation's mutation set:
      // `unchanged` is asserted for it by the isolation invariant below.
      storageAfter: "draftAdvanced",
    },
  },
  {
    id: "admin.reset.post.staleRevisionConflicts",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description:
      "Reset is not a lighter operation: a stale precondition is refused exactly like a save.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.staleRevision",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 409,
      body: "errorEnvelope",
      errorCode: "REVISION_CONFLICT",
      contentRevision: 0,
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.reset.post.unknownSource",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description: "`source` is a closed enum; an unknown value is 400 and resets nothing.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.unknownSource",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.reset.post.missingSource",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description:
      "The source is required: a destructive operation must name what it is resetting to.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.missingSource",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.reset.post.unauthenticated",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description: "No session is 401, and the draft is untouched.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.valid",
    },
    auth: { session: "none", csrf: "omitted" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.reset.post.csrfOmitted",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description: "An authenticated reset with no token is 403 and the draft is untouched.",
    request: {
      method: "POST",
      path: ADMIN_CONTENT_RESET_PATH,
      headers: { "content-type": "application/json" },
      body: "reset.valid",
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.reset.get.methodNotAllowed",
    endpoint: ADMIN_CONTENT_RESET_PATH,
    description: "GET on reset returns 405 with Allow: POST.",
    request: { method: "GET", path: ADMIN_CONTENT_RESET_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "POST", ...jsonContentType },
    },
  },

  // ── The media surface (ESZ-036 / ESZ-037) ────────────────────────────────
  //
  // What is replayed here is the *route boundary*: who may call it, what a
  // wrong method answers, and how a delete responds to an id it cannot use.
  // The ingest pipeline is not, and deliberately: a case would have to carry a
  // real JPEG, a truncated JPEG and a PHP script renamed to `.jpg` as literals
  // in an artifact every implementation parses, for the same reason
  // `body.overLimitRejected` is an invariant with a computed body rather than a
  // 64 kB case. `mediaIngest.requirements` states each of those outcomes and
  // the PHP media suite builds the fixtures and asserts them.

  {
    id: "admin.media.get.unauthenticated",
    endpoint: ADMIN_MEDIA_PATH,
    description: "Listing the library with no session is 401 and reveals nothing about it.",
    request: { method: "GET", path: ADMIN_MEDIA_PATH },
    auth: { session: "none" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      headers: jsonContentType,
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.get.anonymousSessionIsRejected",
    endpoint: ADMIN_MEDIA_PATH,
    description: "An anonymous session is not partial authentication on the media surface either.",
    request: { method: "GET", path: ADMIN_MEDIA_PATH },
    auth: { session: "anonymous" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.get.disabledAccountIsRejected",
    endpoint: ADMIN_MEDIA_PATH,
    description:
      "A live session whose account has since been disabled is 401 here, resolved per request rather than at login.",
    request: { method: "GET", path: ADMIN_MEDIA_PATH },
    auth: { session: "authenticated", account: "disabled" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.get.emptyLibrary",
    endpoint: ADMIN_MEDIA_PATH,
    description:
      "An authenticated list on a deployment that has never uploaded anything is an empty array, not a 404.",
    request: { method: "GET", path: ADMIN_MEDIA_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 200,
      body: "mediaLibraryResponse",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL, ...jsonContentType },
      forbiddenHeaderPatterns: { etag: PUBLISHED_ETAG_PATTERN },
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.post.unauthenticated",
    endpoint: ADMIN_MEDIA_PATH,
    description: "An upload with no session is 401 before any byte is inspected.",
    request: {
      method: "POST",
      path: ADMIN_MEDIA_PATH,
      headers: { "content-type": "multipart/form-data; boundary=----eszter" },
    },
    auth: { session: "none", csrf: "omitted" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.post.csrfOmitted",
    endpoint: ADMIN_MEDIA_PATH,
    description: "An authenticated upload with no CSRF token is 403 before any byte is inspected.",
    request: {
      method: "POST",
      path: ADMIN_MEDIA_PATH,
      headers: { "content-type": "multipart/form-data; boundary=----eszter" },
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.post.csrfWrong",
    endpoint: ADMIN_MEDIA_PATH,
    description: "A well-formed token belonging to no session is 403, so shape is not what is checked.",
    request: {
      method: "POST",
      path: ADMIN_MEDIA_PATH,
      headers: { "content-type": "multipart/form-data; boundary=----eszter" },
    },
    auth: { session: "authenticated", csrf: "wrong", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.post.noFilePart",
    endpoint: ADMIN_MEDIA_PATH,
    description:
      "An authenticated, token-carrying upload with no file part at all is 400 VALIDATION_FAILED.",
    request: {
      method: "POST",
      path: ADMIN_MEDIA_PATH,
      headers: { "content-type": "multipart/form-data; boundary=----eszter" },
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL },
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.unauthenticated",
    endpoint: ADMIN_MEDIA_PATH,
    description: "A delete with no session is 401 and the library is untouched.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.unknownId",
    },
    auth: { session: "none", csrf: "omitted" },
    expect: {
      status: 401,
      body: "errorEnvelope",
      errorCode: "UNAUTHENTICATED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.csrfOmitted",
    endpoint: ADMIN_MEDIA_PATH,
    description: "An authenticated delete with no token is 403, checked before the id is read.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.unknownId",
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: {
      status: 403,
      body: "errorEnvelope",
      errorCode: "CSRF_TOKEN_INVALID",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.unknownId",
    endpoint: ADMIN_MEDIA_PATH,
    description: "A well-formed id that names nothing is 404 NOT_FOUND.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.unknownId",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 404,
      body: "errorEnvelope",
      errorCode: "NOT_FOUND",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL },
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.malformedId",
    endpoint: ADMIN_MEDIA_PATH,
    description:
      "An id that does not match the frozen pattern is refused by the request schema, before the library is consulted at all.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.malformedId",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      headers: { "cache-control": ADMIN_CONTENT_CACHE_CONTROL },
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.traversalId",
    endpoint: ADMIN_MEDIA_PATH,
    description:
      "An id carrying `../` is a schema failure like any other malformed id, so no filesystem call ever has to survive one.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.traversalId",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.delete.missingId",
    endpoint: ADMIN_MEDIA_PATH,
    description: "A body with no id is a schema failure, not a delete of nothing.",
    request: {
      method: "DELETE",
      path: ADMIN_MEDIA_PATH,
      headers: jsonContentType,
      body: "mediaDelete.missingId",
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: {
      status: 400,
      body: "errorEnvelope",
      errorCode: "VALIDATION_FAILED",
      storageAfter: "unchanged",
    },
  },
  {
    id: "admin.media.put.methodNotAllowed",
    endpoint: ADMIN_MEDIA_PATH,
    description: "PUT on the media surface returns 405 with Allow: DELETE, GET, POST.",
    request: { method: "PUT", path: ADMIN_MEDIA_PATH },
    auth: { session: "authenticated", account: "enabled" },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "DELETE, GET, POST", ...jsonContentType },
      contentRevision: "absent",
      storageAfter: "unchanged",
    },
  },

  // ── booking backend (Packages 4.3 and 5.1) ─────────────────────────────
  {
    id: "booking.services.get.ok",
    endpoint: PUBLIC_BOOKING_SERVICES_PATH,
    description: "Only active canonical booking services are exposed to the public flow.",
    request: { method: "GET", path: PUBLIC_BOOKING_SERVICES_PATH },
    expect: { status: 200, body: "publicBookableServicesResponse" },
  },
  {
    id: "booking.services.post.methodNotAllowed",
    endpoint: PUBLIC_BOOKING_SERVICES_PATH,
    description: "The active service collection is read-only.",
    request: { method: "POST", path: PUBLIC_BOOKING_SERVICES_PATH },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "GET" },
    },
  },
  {
    id: "booking.availability.post.ok",
    endpoint: PUBLIC_BOOKING_AVAILABILITY_PATH,
    description: "An active canonical service returns only bounded, ordered, computed slots.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKING_AVAILABILITY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"serviceKey":"brows","fromDate":"2026-06-15","untilDate":"2026-06-15"}',
    },
    expect: { status: 200, body: "bookingAvailabilityResponse" },
  },
  {
    id: "booking.availability.post.invalidService",
    endpoint: PUBLIC_BOOKING_AVAILABILITY_PATH,
    description: "A service key outside SiteContent is rejected without exposing internals.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKING_AVAILABILITY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"serviceKey":"unknown","fromDate":"2026-06-15","untilDate":"2026-06-15"}',
    },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "booking.availability.post.invalidDateShape",
    endpoint: PUBLIC_BOOKING_AVAILABILITY_PATH,
    description: "Malformed local dates are rejected by the closed request schema.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKING_AVAILABILITY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"serviceKey":"brows","fromDate":"15-06-2026","untilDate":"2026-06-15"}',
    },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "booking.availability.get.methodNotAllowed",
    endpoint: PUBLIC_BOOKING_AVAILABILITY_PATH,
    description: "Availability is a JSON query with one frozen POST method.",
    request: { method: "GET", path: PUBLIC_BOOKING_AVAILABILITY_PATH },
    expect: {
      status: 405,
      body: "errorEnvelope",
      errorCode: "METHOD_NOT_ALLOWED",
      headers: { allow: "POST" },
    },
  },
  {
    id: "booking.create.post.ok",
    endpoint: PUBLIC_BOOKINGS_PATH,
    description:
      "A currently available slot with explicit consent for the current catalog notice creates one confirmed booking and returns no customer data.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: `{"serviceKey":"brows","startsAtUtc":"2026-06-15T07:00:00.000Z","customerName":"Cliente Exemple","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null,"consentNoticeId":"${BOOKING_CONSENT_CURRENT_NOTICE_ID}","consentAccepted":true}`,
    },
    expect: { status: 201, body: "publicBookingResponse" },
  },
  {
    id: "booking.create.post.staleSlot",
    endpoint: PUBLIC_BOOKINGS_PATH,
    description:
      "A slot lost before transactional revalidation is a generic 409.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: `{"serviceKey":"brows","startsAtUtc":"2026-06-15T07:15:00.000Z","customerName":"Cliente Exemple","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null,"consentNoticeId":"${BOOKING_CONSENT_CURRENT_NOTICE_ID}","consentAccepted":true}`,
    },
    expect: { status: 409, body: "errorEnvelope", errorCode: "SLOT_UNAVAILABLE" },
  },
  {
    id: "booking.create.post.invalidConsent",
    endpoint: PUBLIC_BOOKINGS_PATH,
    description:
      "Consent must be explicitly true before customer facts reach persistence.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: `{"serviceKey":"brows","startsAtUtc":"2026-06-15T07:00:00.000Z","customerName":"Cliente Exemple","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null,"consentNoticeId":"${BOOKING_CONSENT_CURRENT_NOTICE_ID}","consentAccepted":false}`,
    },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "booking.create.post.missingConsentNotice",
    endpoint: PUBLIC_BOOKINGS_PATH,
    description:
      "ESZ-142 — a request without the consent notice id cannot name which wording was accepted, so it is refused before persistence.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"serviceKey":"brows","startsAtUtc":"2026-06-15T07:00:00.000Z","customerName":"Cliente Exemple","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null,"consentAccepted":true}',
    },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "booking.create.post.unknownConsentNotice",
    endpoint: PUBLIC_BOOKINGS_PATH,
    description:
      "ESZ-142 — an id the immutable catalog does not contain is refused before persistence; the server never guesses which notice the client meant.",
    request: {
      method: "POST",
      path: PUBLIC_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"serviceKey":"brows","startsAtUtc":"2026-06-15T07:00:00.000Z","customerName":"Cliente Exemple","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null,"consentNoticeId":"booking-consent-9999","consentAccepted":true}',
    },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.bookings.query.post.ok",
    endpoint: ADMIN_BOOKINGS_QUERY_PATH,
    description:
      "An authenticated range read lists the current-state booking records with their pagination facts and no per-booking history, without CSRF.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"mode":"range","fromDate":"2026-06-15","untilDate":"2026-06-15"}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "adminBookingsResponse" },
  },
  {
    id: "admin.bookings.query.post.referenceOk",
    endpoint: ADMIN_BOOKINGS_QUERY_PATH,
    description:
      "ESZ-145 — the reference detail read returns the booking's current facts beside one fixed, bounded page of its history with explicit pagination metadata, without CSRF.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"mode":"reference","reference":"bk_00000000000000000000000000000000"}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "adminBookingReferenceResponse" },
  },
  {
    id: "admin.bookings.query.post.malformedHistoryCursor",
    endpoint: ADMIN_BOOKINGS_QUERY_PATH,
    description:
      "ESZ-145 — a history continuation cursor is typed and validated: a reference request whose eventId is not a positive integer is refused by the schema before any read.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"mode":"reference","reference":"bk_00000000000000000000000000000000","historyCursor":{"eventId":0}}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.bookings.query.post.unauthenticated",
    endpoint: ADMIN_BOOKINGS_QUERY_PATH,
    description: "An anonymous booking query is rejected before its body is inspected.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"mode":"range","fromDate":"2026-06-15","untilDate":"2026-06-15"}',
    },
    auth: { session: "none" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.bookings.query.post.malformedCursor",
    endpoint: ADMIN_BOOKINGS_QUERY_PATH,
    description:
      "A continuation cursor is typed and validated: a range request whose cursor names a malformed booking reference is refused by the schema before any read.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"mode":"range","fromDate":"2026-06-15","untilDate":"2026-06-15","cursor":{"startsAtUtc":"2026-06-15T07:00:00.000Z","reference":"not-a-booking"}}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.bookings.moveAvailability.post.ok",
    endpoint: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
    description: "Authenticated move availability is computed by the server while excluding the booking itself.",
    request: {
      method: "POST",
      path: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"reference":"bk_00000000000000000000000000000000","fromDate":"2026-06-15","untilDate":"2026-06-15"}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "bookingAvailabilityResponse" },
  },
  {
    id: "admin.bookings.moveAvailability.post.unauthenticated",
    endpoint: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
    description: "Anonymous move-slot discovery is refused before body parsing.",
    request: { method: "POST", path: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH, rawBody: "{invalid" },
    auth: { session: "none" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.bookings.patch.updateOk",
    endpoint: ADMIN_BOOKINGS_PATH,
    description:
      "Customer corrections are an explicit authenticated CSRF-protected mutation carrying the booking's own updatedAt as its ESZ-139 optimistic-concurrency token.",
    request: {
      method: "PATCH",
      path: ADMIN_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"action":"update","reference":"bk_00000000000000000000000000000000","expectedUpdatedAt":"2026-06-13T12:00:00.000Z","customerName":"Cliente Corrigée","customerEmail":"cliente@example.test","customerPhone":null,"customerNote":null}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminBookingResponse" },
  },
  {
    id: "admin.bookings.patch.moveOk",
    endpoint: ADMIN_BOOKINGS_PATH,
    description:
      "A move returns the same booking reference after transactional slot revalidation, granted against the booking's current ESZ-139 token.",
    request: {
      method: "PATCH",
      path: ADMIN_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"action":"move","reference":"bk_00000000000000000000000000000000","expectedUpdatedAt":"2026-06-13T12:00:00.000Z","startsAtUtc":"2026-06-15T08:00:00.000Z"}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminBookingResponse" },
  },
  {
    id: "admin.bookings.patch.cancelOk",
    endpoint: ADMIN_BOOKINGS_PATH,
    description:
      "Cancellation changes state and retains the booking and its history, granted against the booking's current ESZ-139 token.",
    request: {
      method: "PATCH",
      path: ADMIN_BOOKINGS_PATH,
      headers: { "content-type": "application/json" },
      rawBody:
        '{"action":"cancel","reference":"bk_00000000000000000000000000000000","expectedUpdatedAt":"2026-06-13T12:00:00.000Z","reason":"Indisponible"}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminBookingResponse" },
  },
  {
    id: "admin.bookings.patch.unauthenticated",
    endpoint: ADMIN_BOOKINGS_PATH,
    description: "Authentication is checked before CSRF or mutation parsing.",
    request: { method: "PATCH", path: ADMIN_BOOKINGS_PATH, rawBody: "{invalid" },
    auth: { session: "none", csrf: "omitted" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.bookings.patch.csrfOmitted",
    endpoint: ADMIN_BOOKINGS_PATH,
    description: "An authenticated booking mutation without CSRF is rejected before parsing.",
    request: { method: "PATCH", path: ADMIN_BOOKINGS_PATH, rawBody: "{invalid" },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
  {
    id: "admin.bookings.summary.post.ok",
    endpoint: ADMIN_BOOKINGS_SUMMARY_PATH,
    description:
      "The operational summary is an authenticated read: it needs a session, no CSRF, and reports confirmed and cancelled counts separately.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_SUMMARY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"upcomingDays":7}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "adminBookingsSummaryResponse" },
  },
  {
    id: "admin.bookings.summary.post.unauthenticated",
    endpoint: ADMIN_BOOKINGS_SUMMARY_PATH,
    description: "An anonymous caller learns nothing about the day's bookings, not even how many there are.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_SUMMARY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"upcomingDays":7}',
    },
    auth: { session: "none" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.bookings.summary.post.rangeTooLarge",
    endpoint: ADMIN_BOOKINGS_SUMMARY_PATH,
    description: "The horizon is bounded by the schema, so an unbounded scan is a 400 rather than a slow 200.",
    request: {
      method: "POST",
      path: ADMIN_BOOKINGS_SUMMARY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"upcomingDays":365}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.query.post.ok",
    endpoint: ADMIN_AVAILABILITY_QUERY_PATH,
    description:
      "Reading the schedule needs a session and no CSRF, and returns both the weekly rules and the exceptions in the window.",
    request: {
      method: "POST",
      path: ADMIN_AVAILABILITY_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"fromDate":"2026-06-01","untilDate":"2026-06-30"}',
    },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityResponse" },
  },
  {
    id: "admin.availability.query.post.unauthenticated",
    endpoint: ADMIN_AVAILABILITY_QUERY_PATH,
    description: "The opening hours an anonymous caller may see are the computed public slots, not the rules behind them.",
    request: {
      method: "POST",
      path: ADMIN_AVAILABILITY_QUERY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"fromDate":"2026-06-01","untilDate":"2026-06-30"}',
    },
    auth: { session: "none" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.availability.weekly.put.ok",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "One PUT carries the complete intended week and returns the stored result, which is what the editor then renders.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"09:00","endLocal":"12:30","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true},{"weekdayIso":2,"startLocal":"14:00","endLocal":"18:00","foldUtcOffset":null,"validFrom":"2026-09-01","validUntil":"2026-12-31","isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityWeeklyResponse" },
  },
  {
    id: "admin.availability.weekly.put.emptySetIsAllowed",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "An empty rule set is a legitimate schedule — the salon takes no recurring appointments — and is not confused with a malformed one.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityWeeklyResponse" },
  },
  {
    id: "admin.availability.weekly.put.staleRevision",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "A stale global availability revision is 409 REVISION_CONFLICT; it is never an unconditional replacement.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":1,"rules":[]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 409, body: "errorEnvelope", errorCode: "REVISION_CONFLICT" },
  },
  {
    id: "admin.availability.weekly.put.invertedWindow",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description: "A window that ends before it starts is refused by the server, whatever the browser allowed.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"18:00","endLocal":"09:00","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.weekly.put.overlappingWindows",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "Two windows on one weekday whose validity ranges intersect and whose times overlap are refused as a set, before anything is stored.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"09:00","endLocal":"12:30","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true},{"weekdayIso":2,"startLocal":"12:00","endLocal":"15:00","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.weekly.put.malformedTime",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "A time that is not on a real 24-hour clock is refused structurally: `BOOKING_LOCAL_TIME_PATTERN` accepts only 00:00–23:59, so 25:00 never reaches the domain at all. The domain still refuses it independently; the structural check is necessary and, for the range, now also decisive.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"25:00","endLocal":"26:00","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.weekly.put.civilDayBoundsAccepted",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "The two ends of the civil day are ordinary values. A window running from 00:00 to 23:59 is accepted, so tightening the wire pattern to a real clock is proved not to have narrowed the accepted set.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"00:00","endLocal":"23:59","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityWeeklyResponse" },
  },
  {
    id: "admin.availability.weekly.put.hourAboveTwentyThree",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "24:00 is the first value above the clock and the one a lenient pattern lets through. There is no midnight-end convention here: a day ends at 23:59 and the next window starts at 00:00.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"09:00","endLocal":"24:00","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.weekly.put.minuteAboveFiftyNine",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description:
      "The minute field is bounded as well as the hour field. 09:60 is shaped like a time, is not one, and is refused before the domain is consulted.",
    request: {
      method: "PUT",
      path: ADMIN_AVAILABILITY_WEEKLY_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"expectedRevision":0,"rules":[{"weekdayIso":2,"startLocal":"09:60","endLocal":"12:00","foldUtcOffset":null,"validFrom":null,"validUntil":null,"isActive":true}]}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.weekly.put.unauthenticated",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description: "Authentication is resolved before CSRF and before the body is parsed.",
    request: { method: "PUT", path: ADMIN_AVAILABILITY_WEEKLY_PATH, rawBody: "{invalid" },
    auth: { session: "none", csrf: "omitted" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.availability.weekly.put.csrfOmitted",
    endpoint: ADMIN_AVAILABILITY_WEEKLY_PATH,
    description: "Replacing the schedule is state-changing, so a session alone does not authorise it.",
    request: { method: "PUT", path: ADMIN_AVAILABILITY_WEEKLY_PATH, rawBody: "{invalid" },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
  {
    id: "admin.availability.exceptions.patch.closeOk",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description: "A closure replaces that date's weekly windows with nothing at all.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"close","expectedRevision":0,"localDate":"2026-08-15","note":"Jour férié"}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityExceptionResponse" },
  },
  {
    id: "admin.availability.exceptions.patch.openOk",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description:
      "An exceptional opening carries the complete window set for that date; it is a replacement and is never merged with the weekly rules.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"open","expectedRevision":0,"localDate":"2026-08-16","windows":[{"startLocal":"10:00","endLocal":"12:00","foldUtcOffset":null},{"startLocal":"14:00","endLocal":"16:00","foldUtcOffset":null}],"note":null}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityExceptionResponse" },
  },
  {
    id: "admin.availability.exceptions.patch.staleRevision",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description:
      "A stale exception mutation is 409 REVISION_CONFLICT against the same revision used by weekly writes.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"close","expectedRevision":1,"localDate":"2026-08-15","note":null}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 409, body: "errorEnvelope", errorCode: "REVISION_CONFLICT" },
  },
  {
    id: "admin.availability.exceptions.patch.removeOk",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description: "Removing the exception restores the weekly behaviour and returns a null exception to say so.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"remove","expectedRevision":0,"localDate":"2026-08-15"}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 200, body: "adminAvailabilityExceptionResponse" },
  },
  {
    id: "admin.availability.exceptions.patch.emptyOpenWindowSet",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description:
      "An open exception with no windows is refused rather than silently stored as a closure; a closure is its own explicit action.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"open","expectedRevision":0,"localDate":"2026-08-16","windows":[],"note":null}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.exceptions.patch.nonexistentLocalTime",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description:
      "A window boundary inside the spring-forward gap names an instant that does not exist in Europe/Paris and is refused rather than shifted.",
    request: {
      method: "PATCH",
      path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      headers: { "content-type": "application/json" },
      rawBody: '{"action":"open","expectedRevision":0,"localDate":"2027-03-28","windows":[{"startLocal":"02:30","endLocal":"04:00","foldUtcOffset":null}],"note":null}',
    },
    auth: { session: "authenticated", csrf: "valid", account: "enabled" },
    expect: { status: 400, body: "errorEnvelope", errorCode: "VALIDATION_FAILED" },
  },
  {
    id: "admin.availability.exceptions.patch.unauthenticated",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description: "Anonymous callers cannot close the salon, and are refused before the body is read.",
    request: { method: "PATCH", path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH, rawBody: "{invalid" },
    auth: { session: "none", csrf: "omitted" },
    expect: { status: 401, body: "errorEnvelope", errorCode: "UNAUTHENTICATED" },
  },
  {
    id: "admin.availability.exceptions.patch.csrfOmitted",
    endpoint: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
    description: "An authenticated exception mutation without CSRF is rejected before parsing.",
    request: { method: "PATCH", path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH, rawBody: "{invalid" },
    auth: { session: "authenticated", csrf: "omitted", account: "enabled" },
    expect: { status: 403, body: "errorEnvelope", errorCode: "CSRF_TOKEN_INVALID" },
  },
];

/**
 * Behaviour that is part of the freeze but is not expressible as a single
 * request/response case. Each entry must stay covered by a named test.
 */
export const httpContractInvariants = [
  {
    id: "requestId.presentOnEveryResponse",
    description:
      "Every response carries X-Request-Id, and error bodies repeat the same value in error.requestId.",
  },
  {
    id: "etag.stableAcrossRequests",
    description:
      "Two reads of an unchanged revision return byte-identical ETag values.",
  },
  {
    id: "etag.derivedOnlyFromRevision",
    description:
      "The ETag depends on revision alone; content changes without a revision bump are not reflected.",
  },
  {
    id: "content.legacyAppearanceNormalized",
    description:
      "A stored envelope without `appearance` is served with defaultSiteAppearance applied and an unchanged ETag.",
  },
  {
    id: "errors.leakNothing",
    description:
      "Error bodies never contain filesystem paths, storage file names or schema internals.",
  },
  {
    id: "health.doesNotDependOnContentStorage",
    description:
      "GET /api/health answers 200 without reading, locking or validating content storage, so unreadable content cannot make the service look down.",
  },
  {
    id: "body.overLimitRejected",
    description:
      "A request body over REQUEST_BODY_LIMIT is rejected with 400 INVALID_JSON before routing, whatever the path, method or Content-Type, except POST /api/admin/media, whose independently bounded multipart envelope is rejected with 413 PAYLOAD_TOO_LARGE.",
  },
  {
    id: "page.etagMatchesContentEndpoint",
    description:
      "For one published revision, GET / and GET /api/content mint the same ETag and send the same Cache-Control, so a publish invalidates both together.",
  },
  {
    id: "page.degradesToBakedDefaults",
    description:
      "Unusable published content serves the exported file unchanged with 200 and no published ETag. The public page never renders an error.",
  },
  {
    id: "page.injectionCannotBreakOutOfTheScript",
    description:
      "Editorial copy containing `</script>`, `<!--`, quotes or ampersands is encoded so that it cannot terminate the bootstrap element or introduce markup.",
  },
  {
    id: "page.appearanceIsColoursOnly",
    description:
      "The injected appearance block contains only CSS custom properties whose values are validated hex colours; no other editorial value reaches CSS.",
  },
  {
    id: "auth.sessionIdRotatesOnLogin",
    description:
      "A successful login answers with a session id different from the one the request carried, and the pre-login record is destroyed rather than left usable. An id fixed before login therefore confers nothing after it.",
  },
  {
    id: "auth.csrfTokenRotatesWithTheSession",
    description:
      "The CSRF token a caller held before login stops being accepted once the session id rotates, so a token captured from the anonymous session cannot be replayed against the authenticated one.",
  },
  {
    id: "auth.logoutInvalidatesServerSide",
    description:
      "After logout, replaying the exact pre-logout session cookie is anonymous. Invalidation is the destruction of the server-side record, not the expiry of the cookie, so a client that ignores Set-Cookie gains nothing.",
  },
  {
    id: "auth.logoutFailureIsNotASuccess",
    description:
      "A logout whose server-side session destruction fails answers an error status, publishes no successful cookie clear and records no logout success; the session it failed to destroy keeps authorising, so no client is ever told it is signed out when the server did not revoke. Only a destroyed record arms the cookie expiry.",
  },
  {
    id: "auth.failureModesAreIndistinguishable",
    description:
      "Unknown address, wrong password and disabled account produce byte-identical responses apart from the request id, and all three perform a password verification so their timing does not separate them either.",
  },
  {
    id: "auth.disabledAccountIsRejectedOnEveryRequest",
    description:
      "Disabling a signed-in account makes its existing session anonymous on the next request; enforcement is not deferred to the next login.",
  },
  {
    id: "auth.sessionCookieCarriesItsAttributes",
    description:
      "Every Set-Cookie for the session carries HttpOnly, SameSite=Strict, Path=/ and no Domain, and carries Secure whenever the environment is production.",
  },
  {
    id: "auth.responsesNeverEchoSecrets",
    description:
      "No response body or log line contains a password, a password hash, a session id or a database credential.",
  },
  {
    id: "csrf.readsAreExempt",
    description:
      "GET /api/auth/session and the public read-only surface answer normally with no CSRF token, so a client can always obtain one without already having one.",
  },
  {
    id: "adminSessions.passwordRotationRevokesEverySession",
    description:
      "Changing an existing admin account's password is a credential rotation: it revokes every session of that account, and the hash update and the revocation commit in one MySQL transaction or both roll back — a revocation failure leaves the old hash and the old sessions in place, and an account update failure revokes nothing. The automatic login-time password_needs_rehash() upgrade is maintenance, not a rotation, and must not revoke the session it just authenticated. Disabling an account continues to revoke all of its sessions.",
  },
  {
    id: "adminContent.revisionSequenceIsShared",
    description:
      "draft.revision and published.revision are drawn from one sequence: a save moves the head, a publish sets published.revision to the draft head it published, and published.revision <= draft.revision holds after every operation.",
  },
  {
    id: "adminContent.publishIsIdempotentAtAnUnchangedRevision",
    description:
      "Publishing an already-published draft twice yields the same revision and the same published ETag; only publishedAt moves. A retry after a timeout is therefore safe and invalidates no cache for nothing.",
  },
  {
    id: "adminContent.publishInvalidatesBothPublicSurfaces",
    description:
      "After a publish that advanced published.revision, GET / and GET /api/content both mint the new `published-<revision>` ETag and a previously matching If-None-Match no longer answers 304. Invalidation follows from the revision, with no separate cache-busting step.",
  },
  {
    id: "adminContent.publishReadsTheStoredDraftUnderOneLock",
    description:
      "Publish re-reads and re-validates the authoritative draft inside the same exclusive lock acquisition that writes published.json. A draft saved between a read and a write can never be the document that gets published, because there is no gap between them.",
  },
  {
    id: "adminContent.publishIsAllOrNothing",
    description:
      "A publish that fails at any step leaves the previous published envelope readable and byte-identical. No request ever observes a published document whose content, revision and publishedAt come from different operations.",
  },
  {
    id: "adminContent.draftWritesAreAtomicAndBounded",
    description:
      "Every draft write goes through the temp-file/fsync/rename sequence under the exclusive lock, and the 1 MB storage cap still applies. A concurrent reader observes either the old draft or the new one, never a partial file, and no temp file survives a failed write.",
  },
  {
    id: "adminContent.savingADraftDoesNotTouchPublished",
    description:
      "A successful draft save leaves published.json byte-identical, so the public site and its ETag are unaffected. Saving is not a soft publish.",
  },
  {
    id: "adminContent.resetNeverMutatesPublished",
    description:
      "A reset reads published.json and writes only draft.json. published.json is byte-identical afterwards — same content, same revision, same publishedAt — so resetting the draft can never change what the public site serves.",
  },
  {
    id: "adminContent.conflictLeavesStorageUntouched",
    description:
      "A 409 REVISION_CONFLICT on save, publish or reset leaves both envelopes byte-identical and leaves no temp file behind, and reports the current head in x-content-revision so the caller can rebase.",
  },
  {
    id: "adminContent.rejectedRequestsNeverReachStorage",
    description:
      "A 401, a 403 or a 405 on /api/admin/content/* sends no x-content-revision and changes nothing on disk: authentication and the token are resolved before the lock is taken.",
  },
  {
    id: "adminContent.conditionalHeadersAreIgnoredOnTheAdminSurface",
    description:
      "If-Match, If-Unmodified-Since and If-None-Match have no effect on /api/admin/content/*. expectedRevision is the only precondition, so a client cannot believe itself protected by a header this surface does not read.",
  },
  {
    id: "adminContent.adminResponsesAreNeverCacheable",
    description:
      "Every /api/admin/content/* response carries Cache-Control: no-store and no published ETag, so unpublished editorial work is never stored by a browser or an intermediary.",
  },
  {
    id: "adminContent.storageFailuresStayOpaque",
    description:
      "A storage fault on the admin surface answers 500 STORAGE_FAILURE with a body that names no path, file, revision or schema internal, exactly like the public surface. The detail goes to the log.",
  },
  {
    id: "media.acceptanceIsDecidedByBytesAlone",
    description:
      "The upload's declared Content-Type and its filename never influence acceptance, the stored media type or the stored name. A PHP script named `photo.jpg` and sent as `image/jpeg` is refused, and a real JPEG named `x.txt` and sent as `application/octet-stream` is accepted.",
  },
  {
    id: "media.storedNamesAreServerGenerated",
    description:
      "Every stored file is `<id>.<ext>` with a cryptographically random id and an extension derived from the verified type. No client-supplied byte reaches a path, so traversal sequences, double extensions and trailing dots are unrepresentable rather than filtered. Two uploads of identical bytes get different ids.",
  },
  {
    id: "media.uploadIsBoundedIndependentlyOfTheJsonLimit",
    description:
      "REQUEST_BODY_LIMIT still applies to every route other than POST /api/admin/media, which is bounded by MEDIA_UPLOAD_LIMIT_BYTES instead. Raising the upload limit never raises the JSON limit, and an over-limit upload is 413 PAYLOAD_TOO_LARGE without being decoded.",
  },
  {
    id: "media.dimensionsAreBoundedBeforeDecoding",
    description:
      "Width, height and their product are checked against the image header before any decoder runs, so a small file that decodes to an enormous bitmap is refused rather than survived.",
  },
  {
    id: "media.finalisationLeavesNoPartialState",
    description:
      "A failure at any step of ingest leaves no intake file, no temp file, no original, no file under /media/ and no catalogue entry. A byte sequence becomes addressable under /media/ only after every check has passed.",
  },
  {
    id: "media.storedBytesAreTheServersOwnEncoding",
    description:
      "The served derivative is the server's re-encode of the decoded image, not the uploaded bytes, so EXIF — including GPS — is absent from it and the file cannot carry an appended payload.",
  },
  {
    id: "media.responsesNeverNameServerPaths",
    description:
      "No media response, success or error, contains the intake directory, the originals directory, a temp file name or an absolute path. `assets[].path` is the only location any client is told.",
  },
  {
    id: "media.deleteRefusesWhileReferenced",
    description:
      "A delete is refused with 409 MEDIA_REFERENCED while the authoritative draft or the published document points at the asset, and refusing removes nothing — not the file, not the original, not the entry. Neither content revision moves on any media operation.",
  },
  {
    id: "media.contentEditsNeverDeleteAssets",
    description:
      "Saving, publishing or resetting content never removes a media file. Repointing a MediaAsset.src leaves the previous asset in the library, so a mistaken edit is recoverable.",
  },
  {
    id: "media.libraryIsTheOnlyRegistry",
    description:
      "The catalogue records what exists; the content document records what is used. Selecting an asset writes a path into the working draft through the ordinary draft save, so there is one content authority and the library never becomes a second one.",
  },
  {
    id: "media.savedReferencesMustResolve",
    description:
      "A draft save whose content carries a managed src absent from the catalogue is refused 400 VALIDATION_FAILED before anything is written, leaving draft.json and both revisions unchanged. HTTP(S) URLs, non-managed public paths and null remain valid; a valid-looking id under the wrong path or extension fails because membership is compared by exact public path against the catalogue, never by probing the filesystem.",
  },
  {
    id: "media.publishNeverPersistsDanglingReferences",
    description:
      "Publish re-checks the exact stored draft's managed src values against the catalogue inside the same shared boundary acquisition that spans the commit; a stored draft whose managed reference no longer resolves answers 500 STORAGE_FAILURE with published.json readable and byte-identical, so no publish can make a managed path durable that the catalogue does not name.",
  },
  {
    id: "booking.availabilityUsesTheSlotEngine",
    description:
      "Public availability delegates to the canonical SlotEngine, applies the frozen 90-day and result bounds, and never stores generated slots.",
  },
  {
    id: "booking.creationRevalidatesUnderTheDatabaseLock",
    description:
      "Creation starts one SQL transaction, locks the singleton V1 resource row, re-reads service, rules, exceptions and non-cancelled bookings, recomputes the requested UTC slot, then inserts. Different services share the same lock.",
  },
  {
    id: "booking.adminMutationsAreGuardedAndAudited",
    description:
      "Admin update, move and cancel require an authenticated session and CSRF. Move uses the creation lock/revalidation path; every meaningful mutation appends durable history while bookings remains the source of truth. Since ESZ-139 every mutation also carries the booking's updatedAt as expectedUpdatedAt: under the authoritative row lock, and before any write, history or notification, the server compares it byte-for-byte with the current updatedAt and answers 409 REVISION_CONFLICT on a mismatch, writing nothing. A successful mutation stores one derived updatedAt strictly later than the token it was granted against, even under a frozen or backward application clock, so a stale tab can neither overwrite nor supersede a newer admin action.",
  },
  {
    id: "availability.weeklyReplacementIsAllOrNothing",
    description:
      "The whole submitted rule set is validated before anything is written, and the delete-then-reinsert runs inside the availability revision transaction. A refusal or a failure mid-write leaves the previously stored schedule intact; no path can commit part of a week.",
  },
  {
    id: "availability.globalOptimisticConcurrency",
    description:
      "Every admin availability read returns the durable global revision. Weekly and exception mutations require expectedRevision and lock the same system_settings row before any availability write; a match mutates and advances exactly once, while a stale request returns 409 REVISION_CONFLICT with no availability write and no increment.",
  },
  {
    id: "availability.exceptionRemovalRestoresWeekly",
    description:
      "Deleting a date's exception, and only that, makes the weekly rules apply to that date again. The exception never merged with them, so nothing has to be un-merged, and no booking is touched either way.",
  },
  {
    id: "availability.exceptionWindowsAreDstChecked",
    description:
      "Every exception window boundary is converted with the Europe/Paris IANA rules before it is stored: a spring-forward gap is refused outright, and an autumn fall-back overlap is refused unless the caller states which of the two offsets it meant.",
  },
  {
    id: "summary.cancelledNeverInflatesConfirmed",
    description:
      "The summary counts confirmed and cancelled bookings separately by SQL aggregation over the whole window. A cancelled booking appears only in a cancelled count, never in a confirmed count and never in a listed entry, so cancelling a booking always lowers the confirmed number.",
  },
  {
    id: "adminViews.rangeReadsArePaginatedNotClipped",
    description:
      "An admin range read returns at most adminViews.rangeRead.pageSize rows in deterministic (starts_at_utc, reference) keyset order, detects a further page with a pageSize+1 probe and states hasMore plus a typed validated cursor. Rows beyond the old 1000-row cap are reached by paging, never by a silent clip: no range walk stops before hasMore=false except by the declared client page budget.",
  },
  {
    id: "adminViews.summaryCountsAreAggregated",
    description:
      "The operational summary's counts and nextConfirmedStartsAtUtc are SQL aggregations over the whole window, never arithmetic over a capped detail list. today/upcoming entry collections are confirmed-only, bounded at adminViews.summary.listedEntriesMax, and listings.todayComplete/upcomingComplete state whether each collection is complete, so a bounded list is never read as the exhaustive answer.",
  },
  {
    id: "bootstrap.failureUsesFrozenEnvelope",
    description:
      "A failure before the request can be routed answers 500 with the frozen error envelope and a request id, never an HTML error page or a stack trace. Only observable on a per-request runtime.",
  },
] as const;
