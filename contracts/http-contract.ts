import { z } from "zod";
import { isoTimestampSchema } from "./content-envelopes.js";
import { SITE_CONTENT_SCHEMA_VERSION } from "./site-content.js";

/**
 * Frozen HTTP contract for the public read-only surface (ESZ-002).
 *
 * This module is the single source of truth for the wire behaviour of
 * `GET /api/health` and `GET /api/content`. It is deliberately free of any
 * Express, Next.js, filesystem or Node runtime dependency so that the future
 * PHP implementation can be checked against the generated, language-neutral
 * artifacts in `contracts/generated/` without running Node.
 *
 * Bumping HTTP_CONTRACT_VERSION is a breaking change for every consumer.
 */
export const HTTP_CONTRACT_VERSION = 1;

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
  exemptFrom: `GET ${AUTH_SESSION_PATH}, and the read-only public surface, which change no state`,
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

/** Every error code the frozen surface is allowed to emit. */
export const apiErrorCodes = [
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INVALID_JSON",
  "VALIDATION_FAILED",
  "INVALID_CREDENTIALS",
  "UNAUTHENTICATED",
  "CSRF_TOKEN_INVALID",
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
  "errorEnvelope",
  "publicPageHtml",
  "authSessionResponse",
  "empty",
] as const;

export type ContractBodyMatcher = (typeof contractBodyMatchers)[number];

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
    | "unknown";
  description: string;
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    /** Raw body sent verbatim; used to exercise malformed JSON handling. */
    rawBody?: string;
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

  ...(
    [
      "/api/admin/content/draft",
      "/api/admin/content/publish",
      "/api/admin/content/reset",
      "/api/admin/media",
    ] as const
  ).map((path, index) => ({
    id: `unknown.get.unimplementedRoute.${index}`,
    endpoint: "unknown" as const,
    description: `${path} is not implemented and must stay a 404.`,
    request: { method: "GET", path },
    expect: {
      status: 404,
      body: "errorEnvelope" as const,
      errorCode: "NOT_FOUND" as const,
    },
  })),
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
      "A request body over REQUEST_BODY_LIMIT is rejected with 400 INVALID_JSON before routing, whatever the path, method or Content-Type.",
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
    id: "bootstrap.failureUsesFrozenEnvelope",
    description:
      "A failure before the request can be routed answers 500 with the frozen error envelope and a request id, never an HTML error page or a stack trace. Only observable on a per-request runtime.",
  },
] as const;
