import {
  createAppearanceStyleSheet,
  defaultSiteContent,
  publishedContentEnvelopeV1Schema,
  type SiteContent,
} from "@eszter/contracts";

/**
 * The static export's half of the PHP content-injection boundary (ESZ-021).
 *
 * `next build` bakes the canonical defaults into two elements; on the target host
 * PHP rewrites their contents with the published document before sending the file
 * (`docs/hetzner-target-architecture.md` §5). Nothing here runs on a server — the
 * *writer* is `next build`, the *reader* is the browser, and PHP edits the text in
 * between.
 *
 * Both element ids come from `@eszter/contracts` rather than being spelled here,
 * because PHP reads the same names out of `contracts/generated/http-contract.json`.
 * A rename is then a contract change that fails a gate, instead of a silent
 * production regression where injection stops matching and the site quietly
 * serves whatever was last built.
 */
export const CONTENT_ELEMENT_ID = "__ESZTER_CONTENT__";
export const APPEARANCE_ELEMENT_ID = "__ESZTER_APPEARANCE__";

/** Revision used for the baked-in defaults, which have never been published. */
export const UNPUBLISHED_REVISION = 0;

export type PublicContentSource = "injected" | "defaults";

export interface PublicContentResult {
  content: SiteContent;
  source: PublicContentSource;
  revision: number | null;
  publishedAt: string | null;
}

/**
 * Characters that could end the script element or open markup inside it.
 *
 * `JSON.stringify` escapes none of these — they are all legal inside a JSON
 * string — but the HTML parser does not read JSON, it scans for `</script`. One
 * `</script>` in a service description is enough to close the element and drop
 * the rest of the document into the page as markup.
 *
 * Only characters that are **never structural in JSON** are listed. That
 * restriction is the whole design of this function: the escaping runs over
 * already-serialized text, so escaping `"` here would rewrite the delimiters
 * around every key and value and produce something that is no longer JSON at all.
 * PHP can afford `JSON_HEX_QUOT` because `json_encode` applies it inside string
 * values while emitting delimiters separately; a regex over the output cannot
 * tell the two apart, so it does not try.
 *
 * Nothing is lost by leaving `"` alone. The payload is the text content of a
 * `<script>` element, where a quote is inert — quoting only matters when JSON is
 * embedded in an attribute, which this never is. What must be impossible is
 * `</script>`, and escaping `<` alone already makes it so.
 */
const HTML_SENSITIVE = /[<>&'\u2028\u2029]/g;

const HTML_ESCAPES: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "&": "\\u0026",
  "'": "\\u0027",
  // U+2028 and U+2029 are valid raw inside a JSON string but terminate a line in
  // JavaScript source. Written as escapes rather than as themselves so the rule is
  // visible in a diff instead of being two characters that look like nothing.
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * Serializes an envelope for the bootstrap element.
 *
 * The result is still valid JSON — `\u003C` inside a string is exactly `<` — so
 * `JSON.parse` round-trips it to the document that went in.
 */
export function serializePublicContentBootstrap(envelope: unknown): string {
  return JSON.stringify(envelope).replace(
    HTML_SENSITIVE,
    (character) => HTML_ESCAPES[character] ?? character,
  );
}

/** The envelope the export bakes in: the canonical defaults, never published. */
export function createDefaultBootstrapEnvelope() {
  return {
    schemaVersion: 1 as const,
    revision: UNPUBLISHED_REVISION,
    publishedAt: null,
    content: defaultSiteContent,
  };
}

/** The `:root` block the export bakes in, rewritten by PHP at request time. */
export function createDefaultAppearanceStyleSheet(): string {
  return createAppearanceStyleSheet(defaultSiteContent.appearance);
}

function defaultResult(): PublicContentResult {
  return {
    content: defaultSiteContent,
    source: "defaults",
    revision: null,
    publishedAt: null,
  };
}

/**
 * Reads whatever is in the bootstrap element, and never trusts it.
 *
 * The payload is validated against the same frozen envelope schema the API
 * response was checked against, for the same reason the PHP endpoint re-validates
 * on the way out: this is a text substitution performed by another process, and
 * the failure mode of an unvalidated read is a `TypeError` deep inside a render
 * rather than a page.
 *
 * Every failure — element missing, unparseable, wrong shape — lands on the
 * canonical defaults, which is exactly what the surrounding HTML already shows.
 * The page therefore degrades to something correct rather than to something
 * blank, and it cannot throw.
 */
export function readPublicContentBootstrap(
  doc: Pick<Document, "getElementById"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): PublicContentResult {
  if (!doc) return defaultResult();

  const element = doc.getElementById(CONTENT_ELEMENT_ID);
  const raw = element?.textContent?.trim();
  if (!raw) return defaultResult();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultResult();
  }

  const envelope = publishedContentEnvelopeV1Schema.safeParse(parsed);
  if (!envelope.success) return defaultResult();

  return {
    content: envelope.data.content,
    // The export bakes revision 0 with no publish timestamp. Reporting that as
    // `injected` would be a lie on a page PHP never touched, so the unpublished
    // marker is what separates "PHP wrote this" from "this is the build output".
    source: envelope.data.publishedAt === null ? "defaults" : "injected",
    revision: envelope.data.revision,
    publishedAt: envelope.data.publishedAt,
  };
}
