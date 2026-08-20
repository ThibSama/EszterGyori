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
 * The frozen French error messages. They are part of the contract because the
 * frontend and future PHP implementation must not diverge on user-facing copy.
 */
export const apiErrorMessages: Record<ApiErrorCode, string> = {
  NOT_FOUND: "La ressource demandée est introuvable.",
  METHOD_NOT_ALLOWED: "Méthode non autorisée pour cette ressource.",
  INVALID_JSON: "Le corps JSON est invalide.",
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
  endpoint: "/api/health" | "/api/content" | "/" | "unknown";
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
  };
  /**
   * Published envelope revision the fixture server must serve. Omitted when
   * the case does not depend on stored content.
   */
  publishedRevision?: number;
  /** Storage behaviour the fixture server must simulate. */
  storage?: "ok" | "failure" | "malformed";
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
  ...(
    [
      "/api/admin/content/draft",
      "/api/admin/content/publish",
      "/api/admin/content/reset",
      "/api/admin/media",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/session",
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
    id: "bootstrap.failureUsesFrozenEnvelope",
    description:
      "A failure before the request can be routed answers 500 with the frozen error envelope and a request id, never an HTML error page or a stack trace. Only observable on a per-request runtime.",
  },
] as const;
