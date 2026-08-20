import { z } from "zod";
import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  publishedContentEnvelopeV1Schema,
} from "./content-envelopes.js";
import { defaultSiteContent } from "./default-site-content.js";
import { siteContentSchema } from "./site-content.js";
import type { ParityCase, ParityPatchOperation, ParityTarget } from "./semantic-rules.js";

/**
 * Reference implementation of the parity corpus runner (ESZ-003).
 *
 * A PHP port needs exactly three things, all of which are pure data handling:
 * JSON Pointer resolution, the three-operation patch subset, and a mapping from
 * its own validation errors back to JSON Pointer paths. Nothing here depends on
 * Node APIs.
 */

/** Fixed base envelope; the timestamp is frozen so the corpus stays deterministic. */
export const PARITY_BASE_PUBLISHED_AT = "2026-06-13T12:00:00.000Z";
export const PARITY_BASE_REVISION = 7;

export function createParityBase(target: ParityTarget): unknown {
  const content = structuredClone(defaultSiteContent);
  if (target === "siteContent") return content;

  return {
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    revision: PARITY_BASE_REVISION,
    publishedAt: PARITY_BASE_PUBLISHED_AT,
    content,
  };
}

/** Decodes a JSON Pointer (RFC 6901) into its reference tokens. */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }

  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Encodes reference tokens back into a JSON Pointer. */
export function toJsonPointer(tokens: Array<string | number>): string {
  if (tokens.length === 0) return "";
  return `/${tokens
    .map((token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return parseJsonPointer(pointer).reduce<unknown>((current, token) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[token];
  }, document);
}

/** Applies the RFC 6902 subset used by the corpus, in place. */
export function applyParityPatch(
  document: unknown,
  operations: ParityPatchOperation[],
): unknown {
  let root = document;

  for (const operation of operations) {
    const tokens = parseJsonPointer(operation.path);
    if (tokens.length === 0) {
      if (operation.op === "remove") {
        throw new Error("Cannot remove the document root.");
      }
      root = operation.value;
      continue;
    }

    const leaf = tokens[tokens.length - 1]!;
    const parent = tokens.slice(0, -1).reduce<unknown>((current, token) => {
      if (current === null || typeof current !== "object") {
        throw new Error(`Unresolvable pointer segment in ${operation.path}`);
      }
      return (current as Record<string, unknown>)[token];
    }, root);

    if (parent === null || typeof parent !== "object") {
      throw new Error(`Unresolvable parent for ${operation.path}`);
    }

    if (Array.isArray(parent)) {
      const index = Number(leaf);
      if (!Number.isInteger(index)) {
        throw new Error(`Array pointer requires an index: ${operation.path}`);
      }
      if (operation.op === "remove") {
        parent.splice(index, 1);
      } else {
        parent[index] = operation.value;
      }
      continue;
    }

    const record = parent as Record<string, unknown>;
    if (operation.op === "remove") {
      delete record[leaf];
    } else {
      record[leaf] = operation.value;
    }
  }

  return root;
}

export function buildParityDocument(parityCase: ParityCase): unknown {
  return applyParityPatch(createParityBase(parityCase.target), parityCase.patch);
}

function schemaForTarget(target: ParityTarget) {
  return target === "siteContent"
    ? siteContentSchema
    : publishedContentEnvelopeV1Schema;
}

export interface ParityRunResult {
  valid: boolean;
  /** Sorted, de-duplicated is intentionally NOT applied: duplicates are meaningful. */
  issuePaths: string[];
  parsed?: unknown;
}

/** Runs one case against the Zod reference implementation. */
export function runParityCase(parityCase: ParityCase): ParityRunResult {
  const document = buildParityDocument(parityCase);
  const result = schemaForTarget(parityCase.target).safeParse(document);

  if (result.success) {
    return { valid: true, issuePaths: [], parsed: result.data };
  }

  return {
    valid: false,
    issuePaths: issuePathsOf(result.error),
  };
}

/**
 * Maps Zod issues to JSON Pointers relative to the validated document. For the
 * `publishedEnvelope` target, content issues stay prefixed with `/content`,
 * which is why content-level cases use the `siteContent` target instead.
 */
export function issuePathsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    toJsonPointer(issue.path as Array<string | number>),
  );
}
