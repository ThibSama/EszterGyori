import {
  PUBLIC_BOOKING_AVAILABILITY_PATH,
  PUBLIC_BOOKING_SERVICES_PATH,
  PUBLIC_BOOKINGS_PATH,
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

export type PublicBookableService = z.infer<
  typeof publicBookableServicesResponseSchema
>["services"][number];
export type BookingAvailability = z.infer<typeof bookingAvailabilityResponseSchema>;
export type BookingSlot = BookingAvailability["slots"][number];
export type PublicBookingRequest = z.infer<typeof publicBookingCreateRequestSchema>;
export type PublicBookingConfirmation = z.infer<typeof publicBookingResponseSchema>;

export type BookingApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface ReservationBootstrap {
  services: PublicBookableService[];
  content: SiteContent;
  usedDefaultContent: boolean;
}

export const BOOKING_API_MESSAGES = {
  network: "Impossible de joindre le service de réservation. Vérifiez votre connexion puis réessayez.",
  rejected: "Le service de réservation n’a pas pu traiter cette demande. Réessayez dans un instant.",
  malformed: "La réponse du service de réservation est inexploitable. Rechargez la page puis réessayez.",
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
  | { kind: "uncertain"; message: string };

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
    return { ok: false, message: BOOKING_API_MESSAGES.network };
  }

  const body = await readJson(response);
  if (!response.ok) return { ok: false, message: BOOKING_API_MESSAGES.rejected };
  const parsed = publicBookableServicesResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data.services }
    : { ok: false, message: BOOKING_API_MESSAGES.malformed };
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
    return { ok: false, message: BOOKING_API_MESSAGES.network };
  }

  const body = await readJson(response);
  if (!response.ok) return { ok: false, message: BOOKING_API_MESSAGES.rejected };
  const parsed = bookingAvailabilityResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: BOOKING_API_MESSAGES.malformed };
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
  return {
    ok: false,
    failure: { kind: "server", message: BOOKING_API_MESSAGES.server },
  };
}
