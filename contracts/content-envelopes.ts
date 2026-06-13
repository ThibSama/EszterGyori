import { z } from "zod";
import { SITE_CONTENT_SCHEMA_VERSION, siteContentSchema } from "./site-content.js";

export const CONTENT_ENVELOPE_SCHEMA_VERSION = SITE_CONTENT_SCHEMA_VERSION;

const isoTimestampSchema = z
  .string()
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    );
  }, "Doit etre une date ISO 8601 valide.");

const revisionSchema = z
  .number()
  .int("La revision doit etre un entier.")
  .nonnegative("La revision doit etre positive ou egale a zero.");

export const siteContentDraftV1Schema = z
  .object({
    schemaVersion: z.literal(CONTENT_ENVELOPE_SCHEMA_VERSION),
    savedAt: isoTimestampSchema,
    content: siteContentSchema,
  })
  .strict();

export const serverDraftEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(CONTENT_ENVELOPE_SCHEMA_VERSION),
    revision: revisionSchema,
    updatedAt: isoTimestampSchema,
    content: siteContentSchema,
  })
  .strict();

export const publishedContentEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(CONTENT_ENVELOPE_SCHEMA_VERSION),
    revision: revisionSchema,
    publishedAt: isoTimestampSchema,
    content: siteContentSchema,
  })
  .strict();

export type SiteContentDraftV1 = z.infer<typeof siteContentDraftV1Schema>;
export type ServerDraftEnvelopeV1 = z.infer<typeof serverDraftEnvelopeV1Schema>;
export type PublishedContentEnvelopeV1 = z.infer<
  typeof publishedContentEnvelopeV1Schema
>;
