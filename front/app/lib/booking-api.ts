import {
  PUBLIC_BOOKING_AVAILABILITY_PATH,
  PUBLIC_BOOKING_SERVICES_PATH,
  PUBLIC_BOOKINGS_PATH,
  RATE_LIMIT_RETRY_AFTER_HEADER,
  bookingAvailabilityResponseSchema,
  errorEnvelopeSchema,
  publicBookableServicesResponseSchema,
  publicBookingCreateRequestSchema,
  publicBookingResponseSchema,
  publishedContentEnvelopeV1Schema,
  type BookableServiceKey,
  type SiteContent,
} from "@eszter/contracts";
import { z } from "zod";
import { parseRetryAfterSeconds } from "./retry-after";

export type PublicBookableService = z.infer<
  typeof publicBookableServicesResponseSchema
>["services"][number];
export type BookingAvailability = z.infer<typeof bookingAvailabilityResponseSchema>;
export type BookingSlot = BookingAvailability["slots"][number];
export type PublicBookingRequest = z.infer<typeof publicBookingCreateRequestSchema>;
export type PublicBookingConfirmation = z.infer<typeof publicBookingResponseSchema>;

export type BookingApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: BookingReadFailure };

/**
 * A failed public booking *read* (services discovery, availability).
 *
 * `rejected` is every non-2xx that is not a rate-limit refusal — a 500, say.
 * A 429 stays out of it: it is its own kind (ESZ-136), carrying the bounded
 * `Retry-After` seconds when the frozen header was usable, `null` otherwise.
 */
export type BookingReadFailure =
  /** The request never reached a response: offline, DNS, TLS, aborted. */
  | { kind: "network"; message: string }
  /** A non-2xx that is not a rate-limit refusal; the service failed or refused. */
  | { kind: "rejected"; message: string }
  /** 429 `RATE_LIMITED`: slow down. Never read as a service failure. */
  | { kind: "rate-limited"; message: string; retryAfterSeconds: number | null }
  /** A 2xx whose body did not match the frozen schema. Never rendered. */
  | { kind: "malformed"; message: string };

export interface ReservationBootstrap {
  services: PublicBookableService[];
  content: SiteContent;
  usedDefaultContent: boolean;
}

export const BOOKING_API_MESSAGES = {
  network: "Impossible de joindre le service de réservation. Vérifiez votre connexion puis réessayez.",
  rejected: "Le service de réservation n’a pas pu traiter cette demande. Réessayez dans un instant.",
  malformed: "La réponse du service de réservation est inexploitable. Rechargez la page puis réessayez.",
  rateLimited:
    "Trop de demandes ont été envoyées. Patientez quelques instants avant de réessayer.",
  unavailable: "Ce créneau vient d’être réservé. Vos coordonnées sont conservées : choisissez un nouvel horaire.",
  validation: "Certaines informations ont été refusées par le serveur. Vérifiez le formulaire avant de réessayer.",
  server: "Le serveur n’a pas pu confirmer le rendez-vous. Aucune confirmation n’est affichée.",
  uncertain:
    "Nous n’avons pas reçu de confirmation. La demande a peut-être été enregistrée : vérifiez avant de la renvoyer.",
} as const;

export type BookingCreationFailure =
  | { kind: "slot-unavailable"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "server"; message: string }
  | { kind: "uncertain"; message: string }
  /**
   * 429 `RATE_LIMITED` (ESZ-136): the refusal happened before any work, so no
   * booking exists and the visitor's slot and details are still worth
   * keeping. `retryAfterSeconds` is the bounded header value, or `null` when
   * no usable `Retry-After` arrived — still rate-limited, no trusted timer.
   */
  | { kind: "rate-limited"; message: string; retryAfterSeconds: number | null };

export type BookingCreationResult =
  | { ok: true; value: PublicBookingConfirmation }
  | { ok: false; failure: BookingCreationFailure };

export interface SubmissionLock {
  current: boolean;
}

/** Immediate lock: a second click cannot race React's next render. */
export async function withSubmissionLock<T>(
  lock: SubmissionLock,
  operation: () => Promise<T>,
): Promise<T | null> {
  if (lock.current) return null;
  lock.current = true;
  try {
    return await operation();
  } finally {
    lock.current = false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Classifies a non-2xx public read. A 429 — the frozen envelope's
 * `RATE_LIMITED`, or the bare status from a middlebox — is its own failure:
 * it must never surface as the generic "service could not process" copy, and
 * its bounded `Retry-After` travels with it when the header is usable.
 */
function nonOkReadFailure(response: Response, body: unknown): BookingReadFailure {
  const error = errorEnvelopeSchema.safeParse(body);
  const rateLimited =
    response.status === 429
    || (error.success && error.data.error.code === "RATE_LIMITED");
  if (rateLimited) {
    return {
      kind: "rate-limited",
      message: BOOKING_API_MESSAGES.rateLimited,
      retryAfterSeconds: parseRetryAfterSeconds(
        response.headers.get(RATE_LIMIT_RETRY_AFTER_HEADER),
      ),
    };
  }
  return { kind: "rejected", message: BOOKING_API_MESSAGES.rejected };
}

export async function loadBookableServices(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BookingApiResult<PublicBookableService[]>> {
  let response: Response;
  try {
    response = await fetcher(PUBLIC_BOOKING_SERVICES_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", message: BOOKING_API_MESSAGES.network } };
  }

  const body = await readJson(response);
  if (!response.ok) return { ok: false, failure: nonOkReadFailure(response, body) };
  const parsed = publicBookableServicesResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data.services }
    : { ok: false, failure: { kind: "malformed", message: BOOKING_API_MESSAGES.malformed } };
}

export async function loadPublishedContent(
  fallback: SiteContent,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ content: SiteContent; usedDefault: boolean }> {
  try {
    const response = await fetcher("/api/content", {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) return { content: fallback, usedDefault: true };
    const parsed = publishedContentEnvelopeV1Schema.safeParse(await readJson(response));
    if (!parsed.success) return { content: fallback, usedDefault: true };
    return { content: parsed.data.content, usedDefault: false };
  } catch {
    return { content: fallback, usedDefault: true };
  }
}

export async function loadAvailability(
  serviceKey: BookableServiceKey,
  fromDate: string,
  untilDate: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BookingApiResult<BookingAvailability>> {
  let response: Response;
  try {
    response = await fetcher(PUBLIC_BOOKING_AVAILABILITY_PATH, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ serviceKey, fromDate, untilDate }),
      signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", message: BOOKING_API_MESSAGES.network } };
  }

  const body = await readJson(response);
  if (!response.ok) return { ok: false, failure: nonOkReadFailure(response, body) };
  const parsed = bookingAvailabilityResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, failure: { kind: "malformed", message: BOOKING_API_MESSAGES.malformed } };
}

export async function createBooking(
  request: PublicBookingRequest,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BookingCreationResult> {
  const validated = publicBookingCreateRequestSchema.safeParse(request);
  if (!validated.success) {
    return {
      ok: false,
      failure: { kind: "validation", message: BOOKING_API_MESSAGES.validation },
    };
  }

  let response: Response;
  try {
    response = await fetcher(PUBLIC_BOOKINGS_PATH, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(validated.data),
      signal,
    });
  } catch {
    return {
      ok: false,
      failure: { kind: "uncertain", message: BOOKING_API_MESSAGES.uncertain },
    };
  }

  const body = await readJson(response);
  if (response.ok) {
    const parsed = publicBookingResponseSchema.safeParse(body);
    return parsed.success
      && parsed.data.serviceKey === validated.data.serviceKey
      && parsed.data.startsAtUtc === validated.data.startsAtUtc
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          failure: { kind: "uncertain", message: BOOKING_API_MESSAGES.uncertain },
        };
  }

  const error = errorEnvelopeSchema.safeParse(body);
  if (response.status === 409 && error.success && error.data.error.code === "SLOT_UNAVAILABLE") {
    return {
      ok: false,
      failure: { kind: "slot-unavailable", message: BOOKING_API_MESSAGES.unavailable },
    };
  }
  if (
    response.status === 400
    || (error.success && ["VALIDATION_FAILED", "INVALID_JSON"].includes(error.data.error.code))
  ) {
    return {
      ok: false,
      failure: { kind: "validation", message: BOOKING_API_MESSAGES.validation },
    };
  }
  // ESZ-136: a 429 — the frozen envelope's RATE_LIMITED, or the bare status
  // from a middlebox — is rate-limiting, never a generic server failure. The
  // refusal happens before any work, so the visitor keeps their slot and
  // details for a later manual retry.
  if (
    response.status === 429
    || (error.success && error.data.error.code === "RATE_LIMITED")
  ) {
    return {
      ok: false,
      failure: {
        kind: "rate-limited",
        message: BOOKING_API_MESSAGES.rateLimited,
        retryAfterSeconds: parseRetryAfterSeconds(
          response.headers.get(RATE_LIMIT_RETRY_AFTER_HEADER),
        ),
      },
    };
  }
  return {
    ok: false,
    failure: { kind: "server", message: BOOKING_API_MESSAGES.server },
  };
}
