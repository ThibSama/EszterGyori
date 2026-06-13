import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  type PublishedContentEnvelopeV1,
  publishedContentEnvelopeV1Schema,
} from "@eszter/contracts";
import { createErrorBody } from "../http-error";
import { isStorageError } from "../storage";

export interface PublishedContentReader {
  readPublished(): Promise<PublishedContentEnvelopeV1>;
}

export function createPublishedEtag(revision: number): string {
  return `"published-${revision}"`;
}

export async function handleGetPublicContent(
  reader: PublishedContentReader,
  request: Request,
  response: Response,
): Promise<void> {
  try {
    const envelope = publishedContentEnvelopeV1Schema.parse(
      await reader.readPublished(),
    );
    const etag = createPublishedEtag(envelope.revision);
    setContentCacheHeaders(response, etag);

    if (ifNoneMatchIncludes(request.headers["if-none-match"], etag)) {
      response.status(304).end();
      return;
    }

    response.status(200).json(envelope);
  } catch (error) {
    if (isStorageError(error) || error instanceof ZodError) {
      console.error("Public content read failed", {
        requestId: request.requestId,
        operation: "readPublished",
        category: isStorageError(error) ? "storage" : "response-validation",
        code: isStorageError(error) ? error.code : "RESPONSE_VALIDATION_FAILED",
      });
      response
        .status(500)
        .json(
          createErrorBody(
            "STORAGE_FAILURE",
            "Le contenu publié est momentanément indisponible.",
            request.requestId,
          ),
        );
      return;
    }

    throw error;
  }
}

export function setContentCacheHeaders(response: Response, etag: string): void {
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
}

export function ifNoneMatchIncludes(
  header: string | string[] | undefined,
  currentEtag: string,
): boolean {
  if (!header) return false;
  const values = Array.isArray(header) ? header : [header];

  return values.some((value) =>
    value
      .split(",")
      .map((candidate) => candidate.trim())
      .some((candidate) => candidate === "*" || candidate === currentEtag),
  );
}
