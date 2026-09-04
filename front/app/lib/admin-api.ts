import {
  ADMIN_CONTENT_DRAFT_PATH,
  ADMIN_CONTENT_PUBLISH_PATH,
  ADMIN_CONTENT_RESET_PATH,
  ADMIN_MEDIA_PATH,
  ADMIN_BOOKINGS_QUERY_PATH,
  ADMIN_BOOKINGS_PATH,
  ADMIN_BOOKING_MOVE_AVAILABILITY_PATH,
  ADMIN_BOOKINGS_SUMMARY_PATH,
  ADMIN_AVAILABILITY_QUERY_PATH,
  ADMIN_AVAILABILITY_WEEKLY_PATH,
  ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  CONTENT_REVISION_HEADER,
  CSRF_HEADER,
  RATE_LIMIT_RETRY_AFTER_HEADER,
  BOOKING_ADMIN_RANGE_MAX_PAGES,
  authSessionResponseSchema,
  errorEnvelopeSchema,
  MEDIA_UPLOAD_FIELD_NAME,
  MEDIA_UPLOAD_LIMIT_BYTES,
  mediaLibraryResponseSchema,
  mediaUploadResponseSchema,
  adminBookingsResponseSchema,
  adminBookingReferenceResponseSchema,
  adminBookingResponseSchema,
  bookingHistoryCursorSchema,
  bookingAvailabilityResponseSchema,
  adminBookingsSummaryResponseSchema,
  adminAvailabilityResponseSchema,
  adminAvailabilityWeeklyResponseSchema,
  adminAvailabilityExceptionResponseSchema,
  publishedContentEnvelopeV1Schema,
  serverDraftEnvelopeV1Schema,
  type ApiErrorCode,
  type AuthSessionResponse,
  type MediaAssetMetadata,
  type MediaLibraryResponse,
  type MediaUploadResponse,
  type PublishedContentEnvelopeV1,
  type ServerDraftEnvelopeV1,
  type SiteContent,
} from "@eszter/contracts";
import { z } from "zod";
import { parseRetryAfterSeconds } from "./retry-after";

export type AdminBooking = z.infer<typeof adminBookingResponseSchema>["booking"];
export type AdminBookingsCursor = { startsAtUtc: string; reference: string };
export type AdminBookingsPage = z.infer<typeof adminBookingsResponseSchema>["page"];
/**
 * ESZ-145 — the typed history continuation of the reference detail read. The
 * `eventId` is the monotonic history row id of the last event the previous
 * page exposed; the next page begins strictly after it. Opaque: echo it, never
 * build one.
 */
export type AdminBookingHistoryCursor = z.infer<typeof bookingHistoryCursorSchema>;
export type AdminBookingHistoryPage = z.infer<
  typeof adminBookingReferenceResponseSchema
>["historyPage"];
export type AdminBookingsQuery =
  | {
      mode: "reference";
      reference: string;
      // ESZ-145 — optional continuation for the booking's history pages.
      // Absent means the first page of its trail. The calendar sends none:
      // it adopts the current-state booking and never walks history in V1.
      historyCursor?: AdminBookingHistoryCursor;
    }
  | {
      mode: "range";
      fromDate: string;
      untilDate: string;
      // Absent on the first page, a typed keyset cursor after it. Never null:
      // the wire schema has no null cursor, so the type does not either.
      cursor?: AdminBookingsCursor;
    };
/**
 * ESZ-145 — the query result splits by mode. A range read is a page of
 * current-state booking facts with its pagination envelope and no history. The
 * reference detail read is the booking's current facts beside one fixed,
 * bounded page of its history. {@link asRangeResult} and
 * {@link asReferenceResult} narrow a parsed result to the side the caller
 * asked for.
 */
export type AdminBookingsRangeResult = {
  bookings: AdminBooking[];
  page: AdminBookingsPage;
};
export type AdminBookingsReferenceResult = {
  booking: AdminBooking;
  historyPage: AdminBookingHistoryPage;
};
export type AdminBookingsQueryResult = AdminBookingsRangeResult | AdminBookingsReferenceResult;

/** Narrowing for the range callers: a parsed range page has `bookings`. */
export function asRangeResult(value: AdminBookingsQueryResult): AdminBookingsRangeResult | null {
  return "bookings" in value ? value : null;
}

/** Narrowing for the reference callers: a parsed reference read has `booking`. */
export function asReferenceResult(
  value: AdminBookingsQueryResult,
): AdminBookingsReferenceResult | null {
  return "booking" in value ? value : null;
}
/**
 * ESZ-139 — every admin booking mutation carries the booking's own `updatedAt`
 * as `expectedUpdatedAt`: the V1 optimistic-concurrency token of the row, sent
 * byte-for-byte from the admin response that seeded the editor.
 */
export type AdminBookingMutation =
  | { action: "move"; reference: string; expectedUpdatedAt: string; startsAtUtc: string }
  | { action: "cancel"; reference: string; expectedUpdatedAt: string; reason: string | null }
  | {
      action: "update";
      reference: string;
      expectedUpdatedAt: string;
      customerName: string;
      customerEmail: string;
      customerPhone: string | null;
      customerNote: string | null;
    };
export type AdminMoveAvailability = z.infer<typeof bookingAvailabilityResponseSchema>;
export type AdminBookingsSummary = z.infer<typeof adminBookingsSummaryResponseSchema>;
export type AdminAvailability = z.infer<typeof adminAvailabilityResponseSchema>;
export type AdminWeeklyAvailability = z.infer<typeof adminAvailabilityWeeklyResponseSchema>;
export type AdminAvailabilityExceptionResult = z.infer<
  typeof adminAvailabilityExceptionResponseSchema
>;
export type AdminWeeklyRule = AdminAvailability["weeklyRules"][number];
export type AdminAvailabilityException = AdminAvailability["exceptions"][number];
export type AdminAvailabilityWindow = AdminAvailabilityException["windows"][number];

/** A weekly rule as it is *sent*: no id, because the whole set is replaced. */
export type AdminWeeklyRuleInput = Omit<AdminWeeklyRule, "id">;

export type AdminAvailabilityExceptionMutation =
  | { action: "close"; expectedRevision: number; localDate: string; note: string | null }
  | {
      action: "open";
      expectedRevision: number;
      localDate: string;
      windows: AdminAvailabilityWindow[];
      note: string | null;
    }
  | { action: "remove"; expectedRevision: number; localDate: string };

/**
 * The browser half of the admin API (ESZ-034).
 *
 * Everything privileged happens in PHP. This module is a transport: it names the
 * routes from `@eszter/contracts` rather than spelling them, sends the session
 * cookie, carries the CSRF token in the header the contract froze, and — this is
 * the part that matters — refuses to hand the editor anything it has not
 * validated against the same envelope schemas the server validated on the way
 * out.
 *
 * It deliberately holds no state of its own. The CSRF token is passed in per
 * call and lives in React state for the lifetime of the tab; it is never written
 * to `localStorage`, never put in a URL and never logged. The session id is a
 * `__Host-` cookie the script cannot read at all, which is the point.
 *
 * ## Why every failure is a value
 *
 * A rejected admin write is not exceptional — a stale revision, an expired
 * session and a validation failure are all ordinary outcomes of editing, and each
 * one needs a *different* recovery in the UI. Throwing would flatten them into
 * one `catch`, so the client returns a discriminated failure instead and the
 * editor is forced by the type checker to say what it does about each.
 */

/** A failure the editor has to react to differently for each `kind`. */
export type AdminApiFailure =
  /** The request never reached a response: offline, DNS, TLS, aborted. */
  | { kind: "network"; message: string }
  /** No live session. The editor must stop trusting anything it holds. */
  | { kind: "unauthenticated"; message: string }
  /** The CSRF token was missing, stale or wrong. Recoverable by re-reading it. */
  | { kind: "forbidden"; message: string }
  /** Login only: unknown e-mail, wrong password or disabled account, indistinguishably. */
  | { kind: "invalid-credentials"; message: string }
  /**
   * 429 `RATE_LIMITED` (ESZ-130, ESZ-136): the server refused the request to
   * bound abuse. Recoverable by waiting, never a sign about the session: the
   * anonymous `GET /api/auth/session` bootstrap can be throttled without the
   * caller having any session at all, so this must never be read as an auth
   * result and never retried in a tight loop.
   *
   * `retryAfterSeconds` is the bounded whole seconds parsed from the frozen
   * `Retry-After` header (ESZ-136), or `null` when the header was missing,
   * malformed or otherwise unusable — the refusal is still rate-limited
   * without a trusted timer.
   */
  | { kind: "rate-limited"; message: string; retryAfterSeconds: number | null }
  /** The body failed contract validation server-side. Storage is unchanged. */
  | { kind: "validation"; message: string }
  /**
   * The edited resource moved under this editor. Content routes report their
   * current head in the content revision header; availability deliberately does
   * not reuse that header and therefore returns null here before re-reading.
   *
   * `errorCode` names the frozen code behind the conflict when the server sent
   * a frozen envelope (ESZ-139): the booking calendar must tell a stale-data
   * `REVISION_CONFLICT` apart from a `SLOT_UNAVAILABLE` — both are 409, both
   * are `conflict`, but the recovery differs (reload the booking versus pick
   * another instant). Null only when the 409 body was not a frozen envelope.
   */
  | {
      kind: "conflict";
      message: string;
      currentRevision: number | null;
      errorCode?: "REVISION_CONFLICT" | "SLOT_UNAVAILABLE" | null;
    }
  /** 5xx, including STORAGE_FAILURE. Opaque by design. */
  | { kind: "server"; message: string; status: number }
  /** A 2xx whose body did not match the frozen schema. Never rendered. */
  | { kind: "malformed-response"; message: string }
  /** Upload only: the file is over the route's limit. Fixed by choosing a smaller one. */
  | { kind: "payload-too-large"; message: string }
  /** Media only: the asset is still used by the draft or the published site. */
  | { kind: "media-referenced"; message: string }
  /** Media only: no asset under that id. The library on screen is stale. */
  | { kind: "not-found"; message: string }
  /**
   * Calendar range loads only: a whole month's walk hit the declared page
   * budget. The data that did arrive is genuine but partial, and the message
   * says so — an honest incompleteness instead of a silent clip.
   */
  | { kind: "range-incomplete"; message: string };

export type AdminApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: AdminApiFailure };

export interface DraftSaveSuccess {
  envelope: ServerDraftEnvelopeV1;
}

export interface AdminApiClient {
  readSession(): Promise<AdminApiResult<AuthSessionResponse>>;
  login(
    credentials: { email: string; password: string },
    csrfToken: string,
  ): Promise<AdminApiResult<AuthSessionResponse>>;
  logout(csrfToken: string): Promise<AdminApiResult<null>>;
  readDraft(): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
  saveDraft(
    input: { content: SiteContent; expectedRevision: number },
    csrfToken: string,
  ): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
  publish(
    input: { expectedRevision: number },
    csrfToken: string,
  ): Promise<AdminApiResult<PublishedContentEnvelopeV1>>;
  resetDraft(
    input: { expectedRevision: number },
    csrfToken: string,
  ): Promise<AdminApiResult<ServerDraftEnvelopeV1>>;
  readPublished(): Promise<AdminApiResult<PublishedContentEnvelopeV1>>;
  listMedia(): Promise<AdminApiResult<MediaAssetMetadata[]>>;
  uploadMedia(
    file: File,
    csrfToken: string,
  ): Promise<AdminApiResult<MediaAssetMetadata>>;
  deleteMedia(id: string, csrfToken: string): Promise<AdminApiResult<null>>;
  queryBookings(input: AdminBookingsQuery): Promise<AdminApiResult<AdminBookingsQueryResult>>;
  moveAvailability(input: {
    reference: string;
    fromDate: string;
    untilDate: string;
  }): Promise<AdminApiResult<AdminMoveAvailability>>;
  mutateBooking(
    input: AdminBookingMutation,
    csrfToken: string,
  ): Promise<AdminApiResult<AdminBooking>>;
  bookingsSummary(input: { upcomingDays: number }): Promise<AdminApiResult<AdminBookingsSummary>>;
  readAvailability(input: {
    fromDate: string;
    untilDate: string;
  }): Promise<AdminApiResult<AdminAvailability>>;
  /**
   * Replaces the entire weekly schedule in one request, and resolves with what
   * the server stored — never with what was sent. The caller renders the result.
   */
  replaceWeeklyAvailability(
    input: { expectedRevision: number; rules: AdminWeeklyRuleInput[] },
    csrfToken: string,
  ): Promise<AdminApiResult<AdminWeeklyAvailability>>;
  /** Resolves with `null` after a removal, which is the server saying the date follows the weekly rules again. */
  mutateAvailabilityException(
    input: AdminAvailabilityExceptionMutation,
    csrfToken: string,
  ): Promise<AdminApiResult<AdminAvailabilityExceptionResult>>;
}

/** The only reset source the contract defines. Stated once, sent from here. */
const RESET_SOURCE = "published" as const;

/** `/api/content`, the public read the editor uses to learn the published head. */
const PUBLIC_CONTENT_PATH = "/api/content";

/**
 * User-facing text, in French, one message per outcome.
 *
 * Exported because the tests assert the editor shows *these* strings rather than
 * a regex-shaped approximation of them, and because a message that only exists
 * inline in a component cannot be reused by the login form.
 */
export const ADMIN_API_MESSAGES = {
  network:
    "Le serveur est injoignable. Vérifiez la connexion : aucune modification n’a été envoyée.",
  unauthenticated:
    "La session a expiré. Reconnectez-vous pour continuer à modifier le contenu.",
  forbidden:
    "La requête a été refusée pour raison de sécurité. Rechargez la page puis réessayez.",
  invalidCredentials:
    "Adresse email ou mot de passe incorrect.",
  rateLimited:
    "Trop de demandes ont été envoyées. Attendez quelques instants avant de réessayer.",
  validation:
    "Le contenu envoyé a été refusé par le serveur. Rien n’a été enregistré.",
  conflict:
    "Le brouillon a été modifié ailleurs depuis son chargement. Rien n’a été enregistré.",
  server:
    "Le serveur n’a pas pu traiter la demande. Rien n’a été enregistré.",
  malformedResponse:
    "La réponse du serveur est inexploitable. Rien n’a été appliqué dans l’éditeur.",
  payloadTooLarge:
    "L’image dépasse la taille maximale de 8 Mo. Choisissez un fichier plus léger : rien n’a été envoyé.",
  mediaRejected:
    "Ce fichier n’a pas été accepté. Formats acceptés : JPEG, PNG et WebP, jusqu’à 8 Mo. Rien n’a été enregistré.",
  mediaReferenced:
    "Ce média est encore utilisé par le brouillon ou par le site publié. Retirez-le du contenu, puis réessayez : rien n’a été supprimé.",
  mediaNotFound:
    "Ce média n’existe plus sur le serveur. La médiathèque a été rechargée.",
  bookingsRangeIncomplete:
    "La période contient plus de rendez-vous qu’un chargement complet ne peut en réunir. Le calendrier affiche les rendez-vous reçus, sans garantir qu’ils sont tous là : rechargez la page pour relire la période.",
} as const;

function failure(failure: AdminApiFailure): { ok: false; failure: AdminApiFailure } {
  return { ok: false, failure };
}

/**
 * Reads the revision header off any response, success or conflict.
 *
 * Never defaulted to `0`. The contract is explicit that the header is absent when
 * no revision was read under the lock, and a client that turned that absence into
 * `0` would rebase onto a revision that may not exist.
 */
export function readRevisionHeader(headers: Headers): number | null {
  const raw = headers.get(CONTENT_REVISION_HEADER);
  if (raw === null) return null;

  const revision = Number(raw);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;

  return revision;
}

/** The error code from a frozen error envelope, or `null` if the body is not one. */
function readErrorCode(body: unknown): ApiErrorCode | null {
  const parsed = errorEnvelopeSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

/**
 * Maps a non-2xx response onto the failure the editor reacts to.
 *
 * The code decides, and the status is only the fallback for a body that is not an
 * error envelope at all — a proxy's own 502 page, say. Going the other way round
 * would collapse 403 `CSRF_TOKEN_INVALID`, which is recoverable by re-reading the
 * token, into the same bucket as a genuine authorisation failure.
 */
function failureFromResponse(
  status: number,
  headers: Headers,
  body: unknown,
): AdminApiFailure {
  switch (readErrorCode(body)) {
    case "UNAUTHENTICATED":
      return { kind: "unauthenticated", message: ADMIN_API_MESSAGES.unauthenticated };
    case "INVALID_CREDENTIALS":
      return {
        kind: "invalid-credentials",
        message: ADMIN_API_MESSAGES.invalidCredentials,
      };
    case "RATE_LIMITED":
      return rateLimitedFailure(headers);
    case "CSRF_TOKEN_INVALID":
      return { kind: "forbidden", message: ADMIN_API_MESSAGES.forbidden };
    case "REVISION_CONFLICT":
      return {
        kind: "conflict",
        message: ADMIN_API_MESSAGES.conflict,
        currentRevision: readRevisionHeader(headers),
        errorCode: "REVISION_CONFLICT",
      };
    case "SLOT_UNAVAILABLE":
      // ESZ-139: also 409, also a `conflict` — but the booking calendar must
      // not read it as stale data: the chosen instant was taken, the recovery
      // is another slot, not a reload-and-reconsider.
      return {
        kind: "conflict",
        message: ADMIN_API_MESSAGES.conflict,
        currentRevision: readRevisionHeader(headers),
        errorCode: "SLOT_UNAVAILABLE",
      };
    case "VALIDATION_FAILED":
    case "INVALID_JSON":
      return { kind: "validation", message: ADMIN_API_MESSAGES.validation };
    case "PAYLOAD_TOO_LARGE":
      return { kind: "payload-too-large", message: ADMIN_API_MESSAGES.payloadTooLarge };
    case "MEDIA_REFERENCED":
      return { kind: "media-referenced", message: ADMIN_API_MESSAGES.mediaReferenced };
    case "NOT_FOUND":
      return { kind: "not-found", message: ADMIN_API_MESSAGES.mediaNotFound };
    case "STORAGE_FAILURE":
    case "INTERNAL_ERROR":
    case "INVALID_CONFIGURATION":
      return { kind: "server", message: ADMIN_API_MESSAGES.server, status };
    default:
      break;
  }

  if (status === 401) {
    return { kind: "unauthenticated", message: ADMIN_API_MESSAGES.unauthenticated };
  }
  if (status === 403) {
    return { kind: "forbidden", message: ADMIN_API_MESSAGES.forbidden };
  }
  if (status === 409) {
    return {
      kind: "conflict",
      message: ADMIN_API_MESSAGES.conflict,
      currentRevision: readRevisionHeader(headers),
      // A 409 whose body is not a frozen envelope names no code: callers must
      // fall back on the least specific recovery.
      errorCode: null,
    };
  }
  if (status === 400) {
    return { kind: "validation", message: ADMIN_API_MESSAGES.validation };
  }
  if (status === 404) {
    return { kind: "not-found", message: ADMIN_API_MESSAGES.mediaNotFound };
  }
  if (status === 413) {
    return { kind: "payload-too-large", message: ADMIN_API_MESSAGES.payloadTooLarge };
  }
  if (status === 429) {
    // A bare 429 (proxy or middlebox) is still the status that means "slow
    // down": it is classified as rate-limited, never as a server failure.
    return rateLimitedFailure(headers);
  }

  return { kind: "server", message: ADMIN_API_MESSAGES.server, status };
}

/**
 * The one 429 answer (ESZ-136). The header may be unusable — missing,
 * malformed, negative or absurd — and the failure is still explicitly
 * rate-limited; only `retryAfterSeconds` says whether a trusted delay exists.
 */
function rateLimitedFailure(headers: Headers): AdminApiFailure {
  return {
    kind: "rate-limited",
    message: ADMIN_API_MESSAGES.rateLimited,
    retryAfterSeconds: parseRetryAfterSeconds(
      headers.get(RATE_LIMIT_RETRY_AFTER_HEADER),
    ),
  };
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Builds a client over one `fetch`.
 *
 * Injectable because the tests drive every branch of this file — expiry,
 * conflict, malformed body — against a stub, and because a module that reached
 * for the global `fetch` directly could not be exercised at all under
 * `node:test`.
 */
export function createAdminApiClient(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): AdminApiClient {
  async function send(
    path: string,
    init: RequestInit & { csrfToken?: string },
  ): Promise<
    | { ok: true; status: number; headers: Headers; body: unknown }
    | { ok: false; failure: AdminApiFailure }
  > {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.csrfToken !== undefined) {
      headers.set(CSRF_HEADER, init.csrfToken);
    }
    // A `FormData` body must NOT carry an explicit content-type: the browser
    // has to set it itself so it can append the multipart boundary it generated.
    // Setting `multipart/form-data` by hand produces a request with no boundary,
    // which every server parses as zero parts — an upload that silently arrives
    // empty.
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        headers,
        // The session is a `__Host-` cookie on the same origin as the static
        // export. `same-origin` rather than `include`: there is no cross-origin
        // deployment of this surface, and asking for one would weaken the
        // SameSite=Strict guarantee the contract relies on.
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      // Deliberately no cause, no URL and no error text: this string is rendered,
      // and a network error's message can carry the request target.
      return failure({ kind: "network", message: ADMIN_API_MESSAGES.network });
    }

    let body: unknown = null;
    if (response.status !== 204) {
      const text = await response.text().catch(() => "");
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
    }

    if (!response.ok) {
      return failure(failureFromResponse(response.status, response.headers, body));
    }

    return { ok: true, status: response.status, headers: response.headers, body };
  }

  function parsed<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    body: unknown,
  ): AdminApiResult<T> {
    const result = schema.safeParse(body);
    if (!result.success) {
      return failure({
        kind: "malformed-response",
        message: ADMIN_API_MESSAGES.malformedResponse,
      });
    }
    return { ok: true, value: result.data };
  }

  return {
    async readSession() {
      const response = await send(AUTH_SESSION_PATH, { method: "GET" });
      if (!response.ok) return response;
      return parsed(authSessionResponseSchema, response.body);
    },

    async login(credentials, csrfToken) {
      const response = await send(AUTH_LOGIN_PATH, {
        method: "POST",
        csrfToken,
        body: JSON.stringify(credentials),
      });
      if (!response.ok) return response;
      return parsed(authSessionResponseSchema, response.body);
    },

    async logout(csrfToken) {
      const response = await send(AUTH_LOGOUT_PATH, { method: "POST", csrfToken });
      if (!response.ok) return response;
      return { ok: true, value: null };
    },

    async readDraft() {
      const response = await send(ADMIN_CONTENT_DRAFT_PATH, { method: "GET" });
      if (!response.ok) return response;
      return parsed(serverDraftEnvelopeV1Schema, response.body);
    },

    async saveDraft({ content, expectedRevision }, csrfToken) {
      const response = await send(ADMIN_CONTENT_DRAFT_PATH, {
        method: "PUT",
        csrfToken,
        body: JSON.stringify({ expectedRevision, content }),
      });
      if (!response.ok) return response;
      return parsed(serverDraftEnvelopeV1Schema, response.body);
    },

    async publish({ expectedRevision }, csrfToken) {
      const response = await send(ADMIN_CONTENT_PUBLISH_PATH, {
        method: "POST",
        csrfToken,
        body: JSON.stringify({ expectedRevision }),
      });
      if (!response.ok) return response;
      return parsed(publishedContentEnvelopeV1Schema, response.body);
    },

    async resetDraft({ expectedRevision }, csrfToken) {
      const response = await send(ADMIN_CONTENT_RESET_PATH, {
        method: "POST",
        csrfToken,
        body: JSON.stringify({ expectedRevision, source: RESET_SOURCE }),
      });
      if (!response.ok) return response;
      return parsed(serverDraftEnvelopeV1Schema, response.body);
    },

    async readPublished() {
      const response = await send(PUBLIC_CONTENT_PATH, { method: "GET" });
      if (!response.ok) return response;
      return parsed(publishedContentEnvelopeV1Schema, response.body);
    },

    async listMedia() {
      const response = await send(ADMIN_MEDIA_PATH, { method: "GET" });
      if (!response.ok) return response;

      const library = parsed<MediaLibraryResponse>(mediaLibraryResponseSchema, response.body);
      return library.ok ? { ok: true as const, value: library.value.assets } : library;
    },

    async uploadMedia(file, csrfToken) {
      // Refused here as well as on the server, and the client-side check is the
      // one the person actually benefits from: an 8 MB upload that is going to be
      // rejected costs them the whole transfer before they are told. The server's
      // check is the one that is load-bearing — this one can be bypassed by
      // anyone who wants to, and nothing depends on it.
      if (file.size > MEDIA_UPLOAD_LIMIT_BYTES) {
        return failure({
          kind: "payload-too-large",
          message: ADMIN_API_MESSAGES.payloadTooLarge,
        });
      }

      const body = new FormData();
      body.append(MEDIA_UPLOAD_FIELD_NAME, file);

      const response = await send(ADMIN_MEDIA_PATH, {
        method: "POST",
        csrfToken,
        body,
      });
      if (!response.ok) return response;

      const uploaded = parsed<MediaUploadResponse>(mediaUploadResponseSchema, response.body);
      return uploaded.ok ? { ok: true as const, value: uploaded.value.asset } : uploaded;
    },

    async deleteMedia(id, csrfToken) {
      const response = await send(ADMIN_MEDIA_PATH, {
        method: "DELETE",
        csrfToken,
        body: JSON.stringify({ id }),
      });
      if (!response.ok) return response;
      return { ok: true, value: null };
    },

    async queryBookings(input) {
      const response = await send(ADMIN_BOOKINGS_QUERY_PATH, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      // ESZ-145: the response envelope is per-mode. A range read is a page of
      // current-state facts (the page envelope stays attached: hasMore and
      // nextCursor are contract facts loadBookingsRange must see, never
      // stripped); the reference read is the booking beside its one bounded
      // history page.
      if (input.mode === "range") {
        return parsed(adminBookingsResponseSchema, response.body);
      }
      return parsed(adminBookingReferenceResponseSchema, response.body);
    },

    async moveAvailability(input) {
      const response = await send(ADMIN_BOOKING_MOVE_AVAILABILITY_PATH, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      return parsed(bookingAvailabilityResponseSchema, response.body);
    },

    async mutateBooking(input, csrfToken) {
      const response = await send(ADMIN_BOOKINGS_PATH, {
        method: "PATCH",
        csrfToken,
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      const booking = parsed(adminBookingResponseSchema, response.body);
      return booking.ok ? { ok: true, value: booking.value.booking } : booking;
    },

    async bookingsSummary(input) {
      const response = await send(ADMIN_BOOKINGS_SUMMARY_PATH, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      return parsed(adminBookingsSummaryResponseSchema, response.body);
    },

    async readAvailability(input) {
      const response = await send(ADMIN_AVAILABILITY_QUERY_PATH, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      return parsed(adminAvailabilityResponseSchema, response.body);
    },

    async replaceWeeklyAvailability(input, csrfToken) {
      const response = await send(ADMIN_AVAILABILITY_WEEKLY_PATH, {
        method: "PUT",
        csrfToken,
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      return parsed(adminAvailabilityWeeklyResponseSchema, response.body);
    },

    async mutateAvailabilityException(input, csrfToken) {
      const response = await send(ADMIN_AVAILABILITY_EXCEPTIONS_PATH, {
        method: "PATCH",
        csrfToken,
        body: JSON.stringify(input),
      });
      if (!response.ok) return response;
      return parsed(adminAvailabilityExceptionResponseSchema, response.body);
    },
  };
}

/**
 * ESZ-144 — one complete, guarded walk of an admin booking range.
 *
 * The calendar asks for a whole month in one logical read and must not treat a
 * page as the month. This follows the server's typed cursors until `hasMore`
 * is false, and it refuses to hang or to lie:
 *
 * - a page that ends with `hasMore` must carry a strictly advancing cursor
 *   (an equal or backward cursor is a broken server, surfaced as
 *   malformed-response, never followed into a loop);
 * - an empty page may only mean the range is exhausted;
 * - the whole walk is bounded by the contract's own page budget, and hitting
 *   it is an explicit `range-incomplete` failure — the operator is told the
 *   calendar may be missing rows rather than shown a silently partial month.
 *
 * The walk is page-by-page sequential on purpose: each page is a fresh
 * authenticated read, and the calendar shows the month only once every page
 * of it has arrived.
 */
export async function loadBookingsRange(
  api: AdminApiClient,
  fromDate: string,
  untilDate: string,
): Promise<AdminApiResult<AdminBooking[]>> {
  const collected: AdminBooking[] = [];
  let cursor: AdminBookingsCursor | null = null;

  for (let pageIndex = 0; pageIndex < BOOKING_ADMIN_RANGE_MAX_PAGES; pageIndex += 1) {
    // The request schema makes the cursor optional, not nullable: an absent
    // key is the first page, and a typed cursor every page after it.
    const result = await api.queryBookings({
      mode: "range",
      fromDate,
      untilDate,
      ...(cursor === null ? {} : { cursor }),
    });
    if (!result.ok) return result;

    // The range request's schema already guarantees the parsed value is a
    // range page; the narrowing keeps the union honest for the type checker.
    const rangeResult = asRangeResult(result.value);
    if (rangeResult === null) {
      return failure({
        kind: "malformed-response",
        message: ADMIN_API_MESSAGES.malformedResponse,
      });
    }
    const { bookings, page } = rangeResult;

    if (bookings.length === 0) {
      // An empty page is the server saying the range is exhausted — but only
      // when it also clears hasMore. An empty page that claims a further page
      // exists cannot advance and must not be followed.
      if (page.hasMore) {
        return failure({
          kind: "malformed-response",
          message: ADMIN_API_MESSAGES.malformedResponse,
        });
      }
      return { ok: true, value: collected };
    }

    collected.push(...bookings);

    if (!page.hasMore) {
      return { ok: true, value: collected };
    }
    if (page.nextCursor === null) {
      return failure({
        kind: "malformed-response",
        message: ADMIN_API_MESSAGES.malformedResponse,
      });
    }
    if (cursor !== null && !advances(cursor, page.nextCursor)) {
      return failure({
        kind: "malformed-response",
        message: ADMIN_API_MESSAGES.malformedResponse,
      });
    }
    cursor = page.nextCursor;
  }

  return failure({
    kind: "range-incomplete",
    message: ADMIN_API_MESSAGES.bookingsRangeIncomplete,
  });
}

/** Strict keyset progress: the next cursor must be strictly after the last one. */
function advances(previous: AdminBookingsCursor, next: AdminBookingsCursor): boolean {
  return (
    next.startsAtUtc > previous.startsAtUtc ||
    (next.startsAtUtc === previous.startsAtUtc && next.reference > previous.reference)
  );
}
