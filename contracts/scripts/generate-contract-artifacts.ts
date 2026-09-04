import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  publishedContentEnvelopeV1Schema,
  serverDraftEnvelopeV1Schema,
  siteContentDraftV1Schema,
} from "../content-envelopes.js";
import { siteAppearanceCustomProperties } from "../appearance.js";
import { bookingDomainContract } from "../booking.js";
import { defaultSiteContent } from "../default-site-content.js";
import {
  ADMIN_CONTENT_CACHE_CONTROL,
  ADMIN_CONTENT_DRAFT_PATH,
  ADMIN_CONTENT_PUBLISH_PATH,
  ADMIN_CONTENT_RESET_PATH,
  ADMIN_MEDIA_PATH,
  ADMIN_BOOKINGS_PATH,
  ADMIN_BOOKINGS_QUERY_PATH,
  ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
  ADMIN_BOOKINGS_SUMMARY_PATH,
  ADMIN_AVAILABILITY_QUERY_PATH,
  ADMIN_AVAILABILITY_WEEKLY_PATH,
  ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
  ADMIN_EMAIL_MAX_LENGTH,
  ADMIN_EMAIL_PATTERN,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  PUBLIC_BOOKING_AVAILABILITY_PATH,
  PUBLIC_BOOKING_SERVICES_PATH,
  PUBLIC_BOOKINGS_PATH,
  CONTENT_CACHE_CONTROL,
  CONTENT_REVISION_HEADER,
  CSRF_HEADER,
  HTTP_CONTRACT_VERSION,
  PUBLIC_PAGE_CONTENT_TYPE,
  PUBLIC_PAGE_PATH,
  PUBLISHED_ETAG_PATTERN,
  REQUEST_BODY_LIMIT,
  REQUEST_BODY_LIMIT_BYTES,
  rateLimitPolicy,
  storageLimitReconciliation,
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  REQUEST_ID_PREFIX,
  SESSION_COOKIE_NAME,
  STALE_REVISION_FIXTURE,
  adminAccessControl,
  adminDraftReadOutcome,
  adminDraftSaveOutcome,
  adminDraftSaveRequestSchema,
  adminEmailNormalization,
  adminPublishOutcome,
  adminPublishRequestSchema,
  adminResetOutcome,
  adminResetRequestSchema,
  adminResetSources,
  apiErrorCodes,
  apiErrorMessages,
  authSessionResponseSchema,
  adminBookingMutationRequestSchema,
  adminBookingResponseSchema,
  adminBookingsQueryRequestSchema,
  adminBookingsResponseSchema,
  adminBookingMoveAvailabilityRequestSchema,
  adminBookingsSummaryRequestSchema,
  adminBookingsSummaryResponseSchema,
  adminAvailabilityQueryRequestSchema,
  adminAvailabilityResponseSchema,
  adminAvailabilityWeeklyReplaceRequestSchema,
  adminAvailabilityWeeklyResponseSchema,
  adminAvailabilityExceptionMutationRequestSchema,
  adminAvailabilityExceptionResponseSchema,
  availabilityAdminPolicy,
  bookingAvailabilityRequestSchema,
  bookingAvailabilityResponseSchema,
  bookingApiPolicy,
  bootstrapFailureOutcome,
  contentRevisionSemantics,
  contractImplementations,
  contractRequestBodies,
  csrfContract,
  errorEnvelopeSchema,
  healthResponseSchema,
  httpContractCases,
  httpContractInvariants,
  loginFailureOutcome,
  loginRequestSchema,
  publicBookingCreateRequestSchema,
  publicBookingResponseSchema,
  publicBookableServicesResponseSchema,
  MEDIA_ASSET_ID_PATTERN,
  MEDIA_LIBRARY_SCHEMA_VERSION,
  MEDIA_MAX_DIMENSION,
  MEDIA_MAX_PIXELS,
  MEDIA_MIN_DIMENSION,
  MEDIA_PUBLIC_PATH_PATTERN,
  MEDIA_PUBLIC_PATH_PREFIX,
  MEDIA_UPLOAD_CONTENT_TYPE,
  MEDIA_UPLOAD_ENVELOPE_OVERHEAD_BYTES,
  MEDIA_UPLOAD_FIELD_NAME,
  MEDIA_UPLOAD_LIMIT,
  MEDIA_UPLOAD_LIMIT_BYTES,
  UNKNOWN_MEDIA_ID_FIXTURE,
  mediaDeleteOutcome,
  mediaDeleteRequestSchema,
  mediaFormats,
  mediaIngest,
  mediaLibraryIndexSchema,
  mediaLibraryResponseSchema,
  mediaListOutcome,
  mediaReferenceIntegrity,
  mediaStorageLayout,
  mediaUploadOutcome,
  mediaUploadResponseSchema,
  optimisticConcurrency,
  overLimitBodyOutcome,
  publicPageBootstrap,
  publicPageFallbackOutcome,
  sessionCookie,
} from "../http-contract.js";
import {
  PARITY_BASE_PUBLISHED_AT,
  PARITY_BASE_REVISION,
  createParityBase,
} from "../parity-runtime.js";
import { parityCases, semanticRules } from "../semantic-rules.js";
import { SITE_CONTENT_SCHEMA_VERSION, siteContentSchema } from "../site-content.js";

/**
 * Emits the language-neutral contract artifacts consumed by non-TypeScript
 * implementations (ESZ-003).
 *
 * Invariant: nothing under `contracts/generated/` may be imported by the
 * top-level contract sources. Until ESZ-015 this was enforced by the Docker API
 * build, which copied `contracts/*.ts` only; that image is gone, and the reason
 * that outlives it is simpler — these sources are the *input* to the generator,
 * so importing its output would make regeneration depend on the last generation.
 *
 * Run with `npm run generate` from `contracts/`. `npm run verify:generated`
 * fails when the committed artifacts drift from the Zod sources.
 */

const OUTPUT_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "generated",
);

const BANNER =
  "GENERATED FILE - do not edit by hand. Run `npm run generate` in contracts/.";

interface SchemaTarget {
  file: string;
  title: string;
  description: string;
  schema: z.ZodType;
  io: "input" | "output";
}

const schemaTargets: SchemaTarget[] = [
  {
    file: "site-content.input.schema.json",
    title: "SiteContent (input)",
    description:
      "Structure accepted on the wire and on disk, before normalization. `appearance` is optional here.",
    schema: siteContentSchema,
    io: "input",
  },
  {
    file: "site-content.output.schema.json",
    title: "SiteContent (output)",
    description:
      "Structure after successful validation, with `appearance` defaulted and hex colours normalized.",
    schema: siteContentSchema,
    io: "output",
  },
  {
    file: "published-content-envelope.input.schema.json",
    title: "PublishedContentEnvelopeV1 (input)",
    description: "Body of GET /api/content and the on-disk published.json.",
    schema: publishedContentEnvelopeV1Schema,
    io: "input",
  },
  {
    file: "published-content-envelope.output.schema.json",
    title: "PublishedContentEnvelopeV1 (output)",
    description: "Published envelope after normalization.",
    schema: publishedContentEnvelopeV1Schema,
    io: "output",
  },
  {
    file: "server-draft-envelope.input.schema.json",
    title: "ServerDraftEnvelopeV1 (input)",
    description: "On-disk draft.json. Never exposed by the frozen public surface.",
    schema: serverDraftEnvelopeV1Schema,
    io: "input",
  },
  {
    file: "server-draft-envelope.output.schema.json",
    title: "ServerDraftEnvelopeV1 (output)",
    description:
      "Body of a 200 GET/PUT /api/admin/content/draft and of a 200 POST /api/admin/content/reset, after normalization.",
    schema: serverDraftEnvelopeV1Schema,
    io: "output",
  },
  {
    file: "admin-draft-save-request.schema.json",
    title: "AdminDraftSaveRequest",
    description:
      "Body of PUT /api/admin/content/draft. A complete SiteContent plus the expectedRevision precondition — never a patch, and never unconditional.",
    schema: adminDraftSaveRequestSchema,
    io: "input",
  },
  {
    file: "admin-publish-request.schema.json",
    title: "AdminPublishRequest",
    description:
      "Body of POST /api/admin/content/publish. Carries the precondition and no content: publish takes what is stored, not what the caller sends.",
    schema: adminPublishRequestSchema,
    io: "input",
  },
  {
    file: "admin-reset-request.schema.json",
    title: "AdminResetRequest",
    description:
      "Body of POST /api/admin/content/reset. `source` is a closed enum so a destructive operation must name what it resets to.",
    schema: adminResetRequestSchema,
    io: "input",
  },
  {
    file: "site-content-draft.input.schema.json",
    title: "SiteContentDraftV1 (input)",
    description: "Browser-local admin draft envelope.",
    schema: siteContentDraftV1Schema,
    io: "input",
  },
  {
    file: "health-response.schema.json",
    title: "HealthResponse",
    description: "Body of a 200 GET /api/health.",
    schema: healthResponseSchema,
    io: "output",
  },
  {
    file: "login-request.schema.json",
    title: "LoginRequest",
    description:
      "Body of POST /api/auth/login. Shape only — the password policy in adminPassword is a provisioning rule, not a login rule, so that a policy rejection cannot separate guesses that must stay indistinguishable.",
    schema: loginRequestSchema,
    io: "input",
  },
  {
    file: "auth-session-response.schema.json",
    title: "AuthSessionResponse",
    description:
      "Body of a 200 GET /api/auth/session and of a 200 POST /api/auth/login. Strict: no session id, password hash or internal account id may appear in it.",
    schema: authSessionResponseSchema,
    io: "output",
  },
  {
    file: "media-library-response.schema.json",
    title: "MediaLibraryResponse",
    description:
      "Body of a 200 GET /api/admin/media. Metadata only: no intake path, no originals path and no client filename appears in it.",
    schema: mediaLibraryResponseSchema,
    io: "output",
  },
  {
    file: "media-upload-response.schema.json",
    title: "MediaUploadResponse",
    description:
      "Body of a 201 POST /api/admin/media. Describes the stored derivative — its type, size and dimensions are the server's re-encode, not what was uploaded.",
    schema: mediaUploadResponseSchema,
    io: "output",
  },
  {
    file: "media-delete-request.schema.json",
    title: "MediaDeleteRequest",
    description:
      "Body of DELETE /api/admin/media. The id is a closed pattern, so a path fragment or a traversal sequence is a schema failure rather than something a filesystem call has to survive.",
    schema: mediaDeleteRequestSchema,
    io: "input",
  },
  {
    file: "media-library-index.schema.json",
    title: "MediaLibraryIndex",
    description:
      "The on-disk media catalogue. Never web-reachable; authoritative for what the library contains.",
    schema: mediaLibraryIndexSchema,
    io: "input",
  },
  {
    file: "public-bookable-services-response.schema.json",
    title: "PublicBookableServicesResponse",
    description: "Active canonical booking services without editorial duplication.",
    schema: publicBookableServicesResponseSchema,
    io: "output",
  },
  {
    file: "booking-availability-request.schema.json",
    title: "BookingAvailabilityRequest",
    description: "Public bounded availability query for one canonical service.",
    schema: bookingAvailabilityRequestSchema,
    io: "input",
  },
  {
    file: "booking-availability-response.schema.json",
    title: "BookingAvailabilityResponse",
    description: "Computed slots only; no customer or internal persistence data.",
    schema: bookingAvailabilityResponseSchema,
    io: "output",
  },
  {
    file: "public-booking-create-request.schema.json",
    title: "PublicBookingCreateRequest",
    description:
      "Public booking facts, the explicit consent notice id (one of the immutable booking-domain catalog's entries) and explicit consent for one returned UTC slot.",
    schema: publicBookingCreateRequestSchema,
    io: "input",
  },
  {
    file: "public-booking-response.schema.json",
    title: "PublicBookingResponse",
    description: "Opaque booking confirmation without customer data.",
    schema: publicBookingResponseSchema,
    io: "output",
  },
  {
    file: "admin-bookings-query-request.schema.json",
    title: "AdminBookingsQueryRequest",
    description: "Authenticated exact-reference or bounded-range booking query.",
    schema: adminBookingsQueryRequestSchema,
    io: "input",
  },
  {
    file: "admin-bookings-response.schema.json",
    title: "AdminBookingsResponse",
    description: "Authenticated booking records with minimal durable history.",
    schema: adminBookingsResponseSchema,
    io: "output",
  },
  {
    file: "admin-booking-move-availability-request.schema.json",
    title: "AdminBookingMoveAvailabilityRequest",
    description: "Authenticated move-slot discovery that excludes the booking itself.",
    schema: adminBookingMoveAvailabilityRequestSchema,
    io: "input",
  },
  {
    file: "admin-booking-mutation-request.schema.json",
    title: "AdminBookingMutationRequest",
    description: "Closed update, move or cancellation command.",
    schema: adminBookingMutationRequestSchema,
    io: "input",
  },
  {
    file: "admin-booking-response.schema.json",
    title: "AdminBookingResponse",
    description: "One authenticated booking after a mutation.",
    schema: adminBookingResponseSchema,
    io: "output",
  },
  {
    file: "admin-bookings-summary-request.schema.json",
    title: "AdminBookingsSummaryRequest",
    description: "Authenticated operational summary request with a bounded upcoming horizon.",
    schema: adminBookingsSummaryRequestSchema,
    io: "input",
  },
  {
    file: "admin-bookings-summary-response.schema.json",
    title: "AdminBookingsSummaryResponse",
    description:
      "Today's and the upcoming confirmed bookings with operational counts. Cancelled bookings are counted separately and never listed.",
    schema: adminBookingsSummaryResponseSchema,
    io: "output",
  },
  {
    file: "admin-availability-query-request.schema.json",
    title: "AdminAvailabilityQueryRequest",
    description: "Authenticated read of the canonical weekly rules plus the exceptions in one local date window.",
    schema: adminAvailabilityQueryRequestSchema,
    io: "input",
  },
  {
    file: "admin-availability-response.schema.json",
    title: "AdminAvailabilityResponse",
    description: "The stored schedule: weekly rules and the replacing date exceptions in the requested window.",
    schema: adminAvailabilityResponseSchema,
    io: "output",
  },
  {
    file: "admin-availability-weekly-replace-request.schema.json",
    title: "AdminAvailabilityWeeklyReplaceRequest",
    description:
      "The complete intended weekly schedule. One array on one request, so the replacement is atomic by construction rather than by client sequencing.",
    schema: adminAvailabilityWeeklyReplaceRequestSchema,
    io: "input",
  },
  {
    file: "admin-availability-weekly-response.schema.json",
    title: "AdminAvailabilityWeeklyResponse",
    description: "The weekly rules as stored after the replacement; this is what the editor renders.",
    schema: adminAvailabilityWeeklyResponseSchema,
    io: "output",
  },
  {
    file: "admin-availability-exception-mutation-request.schema.json",
    title: "AdminAvailabilityExceptionMutationRequest",
    description: "Closed, explicit close, open or remove command for one local date.",
    schema: adminAvailabilityExceptionMutationRequestSchema,
    io: "input",
  },
  {
    file: "admin-availability-exception-response.schema.json",
    title: "AdminAvailabilityExceptionResponse",
    description: "The stored exception, or null after a removal restored the weekly behaviour.",
    schema: adminAvailabilityExceptionResponseSchema,
    io: "output",
  },
  {
    file: "error-envelope.schema.json",
    title: "ApiErrorEnvelope",
    description: "Body of every non-2xx JSON response.",
    schema: errorEnvelopeSchema,
    io: "output",
  },
];

/** Stable stringify so the drift check never trips on key ordering. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildSchemaDocument(target: SchemaTarget): unknown {
  const jsonSchema = z.toJSONSchema(target.schema, {
    io: target.io,
    // Refinements and transforms have no JSON Schema equivalent. Emitting a
    // permissive placeholder instead of throwing is deliberate: the lost
    // semantics are re-stated in semantic-rules.json and enforced by the
    // parity corpus, never silently dropped.
    unrepresentable: "any",
  });

  return {
    $comment: BANNER,
    title: target.title,
    description: target.description,
    "x-eszter-io": target.io,
    "x-eszter-contentSchemaVersion": SITE_CONTENT_SCHEMA_VERSION,
    "x-eszter-warning":
      "Structural validation only. Passing this schema is necessary but NOT sufficient; see semantic-rules.json.",
    ...(jsonSchema as Record<string, unknown>),
  };
}

function buildSemanticRulesDocument(): unknown {
  const casesByRule = new Map<string, string[]>();
  for (const parityCase of parityCases) {
    const bucket = casesByRule.get(parityCase.rule) ?? [];
    bucket.push(parityCase.id);
    casesByRule.set(parityCase.rule, bucket);
  }

  return {
    $comment: BANNER,
    contentSchemaVersion: SITE_CONTENT_SCHEMA_VERSION,
    description:
      "Validation semantics that JSON Schema cannot express. An implementation is only contract-compliant when it enforces all of these in addition to the structural schemas.",
    rules: semanticRules.map((rule) => ({
      ...rule,
      parityCaseIds: casesByRule.get(rule.id) ?? [],
    })),
  };
}

function buildParityCorpusDocument(): unknown {
  return {
    $comment: BANNER,
    contentSchemaVersion: SITE_CONTENT_SCHEMA_VERSION,
    description:
      "Executable acceptance corpus. Apply each case's patch to the matching base document, validate, and compare the outcome.",
    patchOperations: ["replace", "add", "remove"],
    pointerSpec: "RFC 6901",
    bases: {
      siteContent: createParityBase("siteContent"),
      publishedEnvelope: createParityBase("publishedEnvelope"),
    },
    baseMetadata: {
      publishedAt: PARITY_BASE_PUBLISHED_AT,
      revision: PARITY_BASE_REVISION,
    },
    cases: parityCases,
  };
}

function buildHttpContractDocument(): unknown {
  return {
    $comment: BANNER,
    httpContractVersion: HTTP_CONTRACT_VERSION,
    contentSchemaVersion: SITE_CONTENT_SCHEMA_VERSION,
    description:
      "Frozen wire behaviour of public content, auth, CMS/media and booking APIs. Any change here is a breaking change.",
    requestId: {
      header: REQUEST_ID_HEADER,
      trustedInboundPattern: REQUEST_ID_PATTERN,
      generatedPrefix: REQUEST_ID_PREFIX,
      note: "Untrusted inbound values are replaced, never echoed. The value is always sent back on the response and repeated in error.requestId.",
    },
    implementations: contractImplementations,
    requestBodyLimit: REQUEST_BODY_LIMIT,
    requestBodyLimitBytes: REQUEST_BODY_LIMIT_BYTES,
    overLimitBody: overLimitBodyOutcome,
    storageLimits: storageLimitReconciliation,
    rateLimit: rateLimitPolicy,
    bootstrapFailure: bootstrapFailureOutcome,
    publicPage: {
      path: PUBLIC_PAGE_PATH,
      contentType: PUBLIC_PAGE_CONTENT_TYPE,
      bootstrap: {
        ...publicPageBootstrap,
        appearanceCustomProperties: siteAppearanceCustomProperties,
      },
      fallback: publicPageFallbackOutcome,
    },
    caching: {
      etagPattern: PUBLISHED_ETAG_PATTERN,
      etagInput: "revision",
      cacheControl: CONTENT_CACHE_CONTROL,
      conditionalRequests:
        "If-None-Match is compared after trimming comma-separated members; `*` always matches. A match returns 304 with ETag and Cache-Control and an empty body.",
      errorResponses:
        "Error responses must never carry a `published-<revision>` ETag. A framework-generated validator on an error body (Express emits a weak ETag) is tolerated and need not be reproduced.",
    },
    auth: {
      paths: {
        login: AUTH_LOGIN_PATH,
        logout: AUTH_LOGOUT_PATH,
        session: AUTH_SESSION_PATH,
      },
      sessionCookie: { ...sessionCookie, name: SESSION_COOKIE_NAME },
      csrf: { ...csrfContract, header: CSRF_HEADER },
      loginFailure: loginFailureOutcome,
      accessControl: adminAccessControl,
      identity: {
        ...adminEmailNormalization,
        emailPattern: ADMIN_EMAIL_PATTERN,
        emailMaxLength: ADMIN_EMAIL_MAX_LENGTH,
        passwordMinLength: ADMIN_PASSWORD_MIN_LENGTH,
        passwordMaxLength: ADMIN_PASSWORD_MAX_LENGTH,
        passwordHash:
          "password_hash() with the runtime's default algorithm, Argon2id preferred and bcrypt acceptable. The hash is never returned by any endpoint.",
      },
    },
    adminContent: {
      paths: {
        draft: ADMIN_CONTENT_DRAFT_PATH,
        publish: ADMIN_CONTENT_PUBLISH_PATH,
        reset: ADMIN_CONTENT_RESET_PATH,
      },
      cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
      revisionHeader: CONTENT_REVISION_HEADER,
      revision: contentRevisionSemantics,
      concurrency: optimisticConcurrency,
      read: adminDraftReadOutcome,
      save: adminDraftSaveOutcome,
      publish: adminPublishOutcome,
      reset: adminResetOutcome,
      resetSources: adminResetSources,
      requestBodies: contractRequestBodies,
      staleRevisionFixture: STALE_REVISION_FIXTURE,
    },
    media: {
      path: ADMIN_MEDIA_PATH,
      cacheControl: ADMIN_CONTENT_CACHE_CONTROL,
      assetIdPattern: MEDIA_ASSET_ID_PATTERN,
      publicPathPrefix: MEDIA_PUBLIC_PATH_PREFIX,
      publicPathPattern: MEDIA_PUBLIC_PATH_PATTERN,
      formats: mediaFormats,
      upload: {
        fieldName: MEDIA_UPLOAD_FIELD_NAME,
        contentType: MEDIA_UPLOAD_CONTENT_TYPE,
        limit: MEDIA_UPLOAD_LIMIT,
        limitBytes: MEDIA_UPLOAD_LIMIT_BYTES,
        envelopeOverheadBytes: MEDIA_UPLOAD_ENVELOPE_OVERHEAD_BYTES,
      },
      dimensions: {
        minDimension: MEDIA_MIN_DIMENSION,
        maxDimension: MEDIA_MAX_DIMENSION,
        maxPixels: MEDIA_MAX_PIXELS,
      },
      storage: mediaStorageLayout,
      ingest: mediaIngest,
      list: mediaListOutcome,
      uploadOutcome: mediaUploadOutcome,
      delete: mediaDeleteOutcome,
      referenceIntegrity: mediaReferenceIntegrity,
      librarySchemaVersion: MEDIA_LIBRARY_SCHEMA_VERSION,
      unknownAssetIdFixture: UNKNOWN_MEDIA_ID_FIXTURE,
    },
    booking: {
      paths: {
        services: PUBLIC_BOOKING_SERVICES_PATH,
        availability: PUBLIC_BOOKING_AVAILABILITY_PATH,
        create: PUBLIC_BOOKINGS_PATH,
        adminQuery: ADMIN_BOOKINGS_QUERY_PATH,
        adminMoveAvailability: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
        adminMutate: ADMIN_BOOKINGS_PATH,
        adminSummary: ADMIN_BOOKINGS_SUMMARY_PATH,
        adminAvailabilityQuery: ADMIN_AVAILABILITY_QUERY_PATH,
        adminAvailabilityWeekly: ADMIN_AVAILABILITY_WEEKLY_PATH,
        adminAvailabilityExceptions: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
      },
      publicErrors:
        "The frozen error envelope only; no booking, customer, SQL, lock or validation detail.",
      adminMutationSecurity: "authenticated session followed by CSRF, before body parsing",
      policy: bookingApiPolicy,
      availabilityAdministration: availabilityAdminPolicy,
    },
    errorCodes: apiErrorCodes,
    errorMessages: apiErrorMessages,
    endpoints: [
      {
        path: "/api/health",
        methods: ["GET"],
        statuses: [200, 400, 405],
        successBodySchema: "health-response.schema.json",
      },
      {
        path: "/api/content",
        methods: ["GET"],
        statuses: [200, 304, 400, 405, 500],
        successBodySchema: "published-content-envelope.output.schema.json",
      },
      {
        path: PUBLIC_PAGE_PATH,
        methods: ["GET", "HEAD"],
        // No 500: an unreadable published document degrades to the exported
        // defaults rather than failing the page (`publicPageFallbackOutcome`).
        statuses: [200, 304, 400, 405],
        successBodySchema: null,
        successContentType: PUBLIC_PAGE_CONTENT_TYPE,
      },
      {
        path: AUTH_SESSION_PATH,
        methods: ["GET"],
        // No 401: this endpoint reports authentication state, it does not
        // require it, which is what lets a caller obtain a CSRF token before
        // it has anything else.
        statuses: [200, 400, 405],
        successBodySchema: "auth-session-response.schema.json",
      },
      {
        path: AUTH_LOGIN_PATH,
        methods: ["POST"],
        // 429 since ESZ-084: both login buckets of `rateLimitPolicy` refuse
        // before the password is verified.
        statuses: [200, 400, 401, 403, 405, 429],
        requestBodySchema: "login-request.schema.json",
        successBodySchema: "auth-session-response.schema.json",
      },
      {
        path: AUTH_LOGOUT_PATH,
        methods: ["POST"],
        statuses: [204, 400, 401, 403, 405],
        successBodySchema: null,
      },
      {
        path: ADMIN_CONTENT_DRAFT_PATH,
        methods: ["GET", "PUT"],
        // 409 is this surface's own: the optimistic-concurrency refusal. 500
        // is here — unlike on /, which degrades — because an editor must be
        // told that storage is unusable rather than shown a stale document.
        statuses: [200, 400, 401, 403, 405, 409, 500],
        requestBodySchema: "admin-draft-save-request.schema.json",
        successBodySchema: "server-draft-envelope.output.schema.json",
      },
      {
        path: ADMIN_CONTENT_PUBLISH_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 403, 405, 409, 500],
        requestBodySchema: "admin-publish-request.schema.json",
        successBodySchema: "published-content-envelope.output.schema.json",
      },
      {
        path: ADMIN_CONTENT_RESET_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 403, 405, 409, 500],
        requestBodySchema: "admin-reset-request.schema.json",
        successBodySchema: "server-draft-envelope.output.schema.json",
      },
      {
        path: ADMIN_MEDIA_PATH,
        methods: ["GET", "POST", "DELETE"],
        // 404 is this surface's own: an id that names no asset. 409 is its
        // other one, and it is not a revision conflict — see
        // `media.delete.refusal`. 413 belongs to the upload alone.
        statuses: [200, 201, 204, 400, 401, 403, 404, 405, 409, 413, 500],
        requestBodySchema: "media-delete-request.schema.json",
        successBodySchema: "media-library-response.schema.json",
      },
      {
        path: PUBLIC_BOOKING_SERVICES_PATH,
        methods: ["GET"],
        statuses: [200, 405, 500],
        successBodySchema: "public-bookable-services-response.schema.json",
      },
      {
        path: PUBLIC_BOOKING_AVAILABILITY_PATH,
        methods: ["POST"],
        statuses: [200, 400, 405, 429, 500],
        requestBodySchema: "booking-availability-request.schema.json",
        successBodySchema: "booking-availability-response.schema.json",
      },
      {
        path: PUBLIC_BOOKINGS_PATH,
        methods: ["POST"],
        statuses: [201, 400, 405, 409, 429, 500],
        requestBodySchema: "public-booking-create-request.schema.json",
        successBodySchema: "public-booking-response.schema.json",
      },
      {
        path: ADMIN_BOOKINGS_QUERY_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 405, 500],
        requestBodySchema: "admin-bookings-query-request.schema.json",
        successBodySchema: "admin-bookings-response.schema.json",
      },
      {
        path: ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 404, 405, 409, 500],
        requestBodySchema: "admin-booking-move-availability-request.schema.json",
        successBodySchema: "booking-availability-response.schema.json",
      },
      {
        path: ADMIN_BOOKINGS_PATH,
        methods: ["PATCH"],
        statuses: [200, 400, 401, 403, 404, 405, 409, 500],
        requestBodySchema: "admin-booking-mutation-request.schema.json",
        successBodySchema: "admin-booking-response.schema.json",
      },
      {
        path: ADMIN_BOOKINGS_SUMMARY_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 405, 500],
        requestBodySchema: "admin-bookings-summary-request.schema.json",
        successBodySchema: "admin-bookings-summary-response.schema.json",
      },
      {
        path: ADMIN_AVAILABILITY_QUERY_PATH,
        methods: ["POST"],
        statuses: [200, 400, 401, 405, 500],
        requestBodySchema: "admin-availability-query-request.schema.json",
        successBodySchema: "admin-availability-response.schema.json",
      },
      {
        path: ADMIN_AVAILABILITY_WEEKLY_PATH,
        methods: ["PUT"],
        statuses: [200, 400, 401, 403, 405, 409, 500],
        requestBodySchema: "admin-availability-weekly-replace-request.schema.json",
        successBodySchema: "admin-availability-weekly-response.schema.json",
      },
      {
        path: ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
        methods: ["PATCH"],
        statuses: [200, 400, 401, 403, 405, 409, 500],
        requestBodySchema: "admin-availability-exception-mutation-request.schema.json",
        successBodySchema: "admin-availability-exception-response.schema.json",
      },
    ],
    unknownRouteStatus: 404,
    errorBodySchema: "error-envelope.schema.json",
    cases: httpContractCases,
    invariants: httpContractInvariants,
  };
}

async function writeArtifact(
  fileName: string,
  document: unknown,
  digests: Record<string, string>,
): Promise<void> {
  const contents = serialize(document);
  digests[fileName] = createHash("sha256").update(contents).digest("hex");
  await writeFile(join(OUTPUT_DIRECTORY, fileName), contents, "utf8");
}

export async function generateContractArtifacts(): Promise<
  Record<string, string>
> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  // Fail loudly before emitting anything if the canonical content regressed.
  siteContentSchema.parse(defaultSiteContent);

  const digests: Record<string, string> = {};

  for (const target of schemaTargets) {
    await writeArtifact(target.file, buildSchemaDocument(target), digests);
  }

  await writeArtifact("semantic-rules.json", buildSemanticRulesDocument(), digests);
  await writeArtifact("parity-corpus.json", buildParityCorpusDocument(), digests);
  await writeArtifact("http-contract.json", buildHttpContractDocument(), digests);
  await writeArtifact("booking-domain.json", bookingDomainContract, digests);

  const manifest = {
    $comment: BANNER,
    contentSchemaVersion: SITE_CONTENT_SCHEMA_VERSION,
    httpContractVersion: HTTP_CONTRACT_VERSION,
    description:
      "Index and integrity digests for the language-neutral contract artifacts.",
    consumerGuidance: [
      "Validate structure with the *.schema.json documents (JSON Schema 2020-12).",
      "Then enforce every rule in semantic-rules.json; JSON Schema alone is insufficient.",
      "Prove compliance by replaying parity-corpus.json and http-contract.json.",
    ],
    artifacts: Object.entries(digests)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, sha256]) => ({ file, sha256 })),
  };

  await writeFile(
    join(OUTPUT_DIRECTORY, "manifest.json"),
    serialize(manifest),
    "utf8",
  );

  return digests;
}

/** Reads what is currently committed, for the drift check. */
export async function readArtifact(fileName: string): Promise<string> {
  return readFile(join(OUTPUT_DIRECTORY, fileName), "utf8");
}

export const artifactFileNames = [
  ...schemaTargets.map((target) => target.file),
  "semantic-rules.json",
  "parity-corpus.json",
  "http-contract.json",
  "booking-domain.json",
];

export function serializeArtifact(fileName: string): string {
  const target = schemaTargets.find((candidate) => candidate.file === fileName);
  if (target) return serialize(buildSchemaDocument(target));
  if (fileName === "semantic-rules.json") {
    return serialize(buildSemanticRulesDocument());
  }
  if (fileName === "parity-corpus.json") return serialize(buildParityCorpusDocument());
  if (fileName === "http-contract.json") return serialize(buildHttpContractDocument());
  if (fileName === "booking-domain.json") return serialize(bookingDomainContract);
  throw new Error(`Unknown artifact: ${fileName}`);
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  const digests = await generateContractArtifacts();
  console.info(
    `Generated ${Object.keys(digests).length + 1} contract artifacts in contracts/generated/.`,
  );
}
