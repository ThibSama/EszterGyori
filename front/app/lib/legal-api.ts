import {
  PUBLIC_LEGAL_INFORMATION_PATH,
  publicLegalInformationResponseSchema,
  type LegalInformation,
} from "@eszter/contracts";

/**
 * ESZ-165 — the public read of the stored legal document.
 *
 * `/mentions-legales` and `/confidentialite` are static exports; what they
 * publish comes from `GET /api/legal` at load, exactly as `/reservation`
 * reads the catalog, so a save in the admin is live on the next page load
 * with no rebuild. The result is either the parsed document or one of three
 * failures the page renders as a neutral "unavailable" line — never as a
 * partially guessed document.
 */
export type LegalInformationResult =
  | { ok: true; value: LegalInformation }
  | { ok: false; failure: { kind: "network" | "rejected" | "malformed"; message: string } };

export const LEGAL_API_MESSAGES = {
  unavailable:
    "Les informations légales sont momentanément indisponibles. Rechargez la page dans un instant.",
} as const;

export async function loadLegalInformation(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LegalInformationResult> {
  let response: Response;
  try {
    response = await fetcher(PUBLIC_LEGAL_INFORMATION_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", message: LEGAL_API_MESSAGES.unavailable } };
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: "rejected", message: LEGAL_API_MESSAGES.unavailable } };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = publicLegalInformationResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data.information }
    : { ok: false, failure: { kind: "malformed", message: LEGAL_API_MESSAGES.unavailable } };
}
