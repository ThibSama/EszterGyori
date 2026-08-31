import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent, publicPageBootstrap } from "@eszter/contracts";
import {
  APPEARANCE_ELEMENT_ID,
  CONTENT_ELEMENT_ID,
  createDefaultAppearanceStyleSheet,
  createDefaultBootstrapEnvelope,
  readPublicContentBootstrap,
  serializePublicContentBootstrap,
} from "../app/lib/public-bootstrap";

/**
 * The frontend half of the PHP injection boundary (ESZ-021).
 *
 * The PHP half is proved separately by `php:http-contract`. What is checked here
 * is the part PHP cannot check: that whatever lands in the bootstrap element is
 * read safely, that a payload written by another process can never take the page
 * down, and that no editorial string can escape the element it is written into.
 */

/** The two-method subset of `document` the reader actually uses. */
function fakeDocument(elements: Record<string, string | null>) {
  return {
    getElementById(id: string) {
      const value = elements[id];
      return value === undefined ? null : { textContent: value };
    },
  } as unknown as Pick<Document, "getElementById">;
}

function injected(envelope: unknown) {
  return fakeDocument({
    [CONTENT_ELEMENT_ID]: serializePublicContentBootstrap(envelope),
  });
}

test("the element ids are the ones the contract publishes to PHP", () => {
  // These names are the injection boundary. PHP reads them out of
  // `contracts/generated/http-contract.json`, which is generated from
  // `publicPageBootstrap` — so if the frontend ever spelled them locally instead,
  // a rename would silently stop injection and the site would serve the last
  // build forever, looking perfectly healthy.
  assert.equal(publicPageBootstrap.contentElementId, CONTENT_ELEMENT_ID);
  assert.equal(publicPageBootstrap.appearanceElementId, APPEARANCE_ELEMENT_ID);
});

test("a published payload is read back as the document PHP injected", () => {
  const envelope = {
    schemaVersion: 1,
    revision: 42,
    publishedAt: "2026-06-13T12:00:00.000Z",
    content: defaultSiteContent,
  };

  const result = readPublicContentBootstrap(injected(envelope));

  assert.equal(result.source, "injected");
  assert.equal(result.revision, 42);
  assert.equal(result.publishedAt, "2026-06-13T12:00:00.000Z");
  assert.deepEqual(result.content, defaultSiteContent);
});

test("the export's own baked envelope reads as defaults, not as injected", () => {
  // `next build` bakes revision 0 with no publish timestamp. Reporting that as
  // injected would claim PHP touched a file it never saw.
  const result = readPublicContentBootstrap(injected(createDefaultBootstrapEnvelope()));

  assert.equal(result.source, "defaults");
  assert.deepEqual(result.content, defaultSiteContent);
});

test("every way the payload can be unusable falls back to the canonical defaults", () => {
  const unusable: Array<[string, Pick<Document, "getElementById">]> = [
    ["element absent", fakeDocument({})],
    ["element empty", fakeDocument({ [CONTENT_ELEMENT_ID]: "" })],
    ["whitespace only", fakeDocument({ [CONTENT_ELEMENT_ID]: "   \n  " })],
    ["not JSON", fakeDocument({ [CONTENT_ELEMENT_ID]: "{ nope" })],
    ["JSON but not an envelope", fakeDocument({ [CONTENT_ELEMENT_ID]: '{"a":1}' })],
    ["envelope with invalid content", injected({
      schemaVersion: 1,
      revision: 3,
      publishedAt: "2026-06-13T12:00:00.000Z",
      content: { ...defaultSiteContent, hero: null },
    })],
    ["no document at all (build time)", undefined as never],
  ];

  for (const [label, doc] of unusable) {
    const result = readPublicContentBootstrap(doc);

    assert.equal(result.source, "defaults", label);
    assert.deepEqual(result.content, defaultSiteContent, label);
    assert.equal(result.revision, null, label);
  }
});

test("editorial copy cannot terminate the bootstrap element", () => {
  // The attack the encoding exists to stop: a service description that closes the
  // script and continues as markup.
  const hostile = {
    schemaVersion: 1,
    revision: 7,
    publishedAt: "2026-06-13T12:00:00.000Z",
    content: {
      ...defaultSiteContent,
      hero: {
        ...defaultSiteContent.hero,
        description: `</script><img src=x onerror=alert(1)> & <!-- '"`,
      },
    },
  };

  const serialized = serializePublicContentBootstrap(hostile);

  for (const character of ["<", ">", "&"]) {
    assert.equal(
      serialized.includes(character),
      false,
      `raw ${character} survived serialization`,
    );
  }
  assert.equal(/<\/script/i.test(serialized), false);

  // Still JSON, and still the same string once parsed — the escaping is lossless.
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.content.hero.description, hostile.content.hero.description);
});

test("the serialized payload is valid JSON, not merely escaped text", () => {
  // A blanket escape of `"` would have rewritten JSON's own delimiters and
  // produced something no parser accepts. This is the regression that caught it.
  const serialized = serializePublicContentBootstrap(createDefaultBootstrapEnvelope());

  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.deepEqual(JSON.parse(serialized), createDefaultBootstrapEnvelope());
});

test("the appearance block contains validated hex colours and nothing else", () => {
  const sheet = createDefaultAppearanceStyleSheet();

  // `page.appearanceIsColoursOnly`: no editorial text, no selectors, no functions
  // — only `--site-*` custom properties whose values are six-digit hex.
  assert.match(sheet, /^:root\{(--site-[a-z-]+:#[0-9A-F]{6};)*--site-[a-z-]+:#[0-9A-F]{6}\}$/);
  assert.equal(sheet.includes("</style"), false);
  assert.equal(sheet.includes("expression"), false);
  assert.equal(sheet.includes("url("), false);
});
