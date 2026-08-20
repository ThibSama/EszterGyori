import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  artifactFileNames,
  serializeArtifact,
} from "../scripts/generate-contract-artifacts.js";
import { parityCases, semanticRules } from "../semantic-rules.js";
import { contractRequestBodies, httpContractCases } from "../http-contract.js";

/**
 * Drift guard. The committed artifacts under `contracts/generated/` are what a
 * non-TypeScript implementation consumes, so they must never fall behind the
 * Zod sources they are derived from.
 */

const GENERATED_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "generated",
);

async function readGenerated(fileName: string): Promise<string> {
  return readFile(join(GENERATED_DIRECTORY, fileName), "utf8");
}

for (const fileName of artifactFileNames) {
  test(`generated artifact is up to date: ${fileName}`, async () => {
    const committed = await readGenerated(fileName);

    assert.equal(
      committed,
      serializeArtifact(fileName),
      `${fileName} is stale. Run \`npm run generate\` in contracts/ and commit the result.`,
    );
  });
}

test("manifest digests match the committed artifacts", async () => {
  const manifest = JSON.parse(await readGenerated("manifest.json")) as {
    artifacts: Array<{ file: string; sha256: string }>;
  };

  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.file).sort(),
    [...artifactFileNames].sort(),
  );

  for (const artifact of manifest.artifacts) {
    const contents = await readGenerated(artifact.file);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      artifact.sha256,
      `${artifact.file}: digest mismatch. Run \`npm run generate\`.`,
    );
  }
});

test("generated schemas warn that structural validation is not sufficient", async () => {
  for (const fileName of artifactFileNames.filter((name) =>
    name.endsWith(".schema.json"),
  )) {
    const schema = JSON.parse(await readGenerated(fileName)) as Record<
      string,
      unknown
    >;

    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(String(schema["x-eszter-warning"]), /NOT sufficient/);
  }
});

test("the published envelope schema keeps objects closed", async () => {
  const schema = JSON.parse(
    await readGenerated("published-content-envelope.input.schema.json"),
  ) as { additionalProperties?: boolean; required?: string[] };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    ["content", "publishedAt", "revision", "schemaVersion"],
  );
});

test("semantic rules and parity cases round-trip through the generated corpus", async () => {
  const corpus = JSON.parse(await readGenerated("parity-corpus.json")) as {
    cases: Array<{ id: string }>;
    bases: Record<string, unknown>;
  };
  const rules = JSON.parse(await readGenerated("semantic-rules.json")) as {
    rules: Array<{ id: string; parityCaseIds: string[] }>;
  };

  assert.deepEqual(
    corpus.cases.map((parityCase) => parityCase.id),
    parityCases.map((parityCase) => parityCase.id),
  );
  assert.deepEqual(
    rules.rules.map((rule) => rule.id),
    semanticRules.map((rule) => rule.id),
  );
  assert.ok(corpus.bases.siteContent);
  assert.ok(corpus.bases.publishedEnvelope);

  for (const rule of rules.rules) {
    assert.ok(
      rule.parityCaseIds.length > 0,
      `${rule.id} reached the generated artifact with no parity cases`,
    );
  }
});

test("the generated HTTP contract carries every frozen case", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    cases: Array<{ id: string }>;
    errorCodes: string[];
    endpoints: Array<{ path: string; methods: string[] }>;
  };

  assert.deepEqual(
    contract.cases.map((httpCase) => httpCase.id),
    httpContractCases.map((httpCase) => httpCase.id),
  );
  assert.deepEqual(
    contract.endpoints.map((endpoint) => endpoint.path).sort(),
    [
      "/",
      "/api/admin/content/draft",
      "/api/admin/content/publish",
      "/api/admin/content/reset",
      "/api/admin/media",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/session",
      "/api/content",
      "/api/health",
    ],
  );

  // `/` accepts HEAD and the JSON surface does not. That difference is deliberate
  // (`page.head.ok`): the page is a document crawlers and monitors probe with
  // HEAD, whereas a 405 on HEAD /api/health has never mattered to anyone.
  const methodsByPath = Object.fromEntries(
    contract.endpoints.map((endpoint) => [endpoint.path, endpoint.methods]),
  );
  assert.deepEqual(methodsByPath["/api/health"], ["GET"]);
  assert.deepEqual(methodsByPath["/api/content"], ["GET"]);
  assert.deepEqual(methodsByPath["/"], ["GET", "HEAD"]);

  // ESZ-025. `/api/auth/session` is a GET because it reads state; the other two
  // change it and are POST-only, so a `<img src>` or a top-level navigation
  // cannot reach them at all before CSRF is even consulted.
  assert.deepEqual(methodsByPath["/api/auth/session"], ["GET"]);
  assert.deepEqual(methodsByPath["/api/auth/login"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/auth/logout"], ["POST"]);

  // Package 3.1. The draft is a resource that is read and replaced whole, so it
  // is GET + PUT on one path. Publish and reset are neither reads nor
  // replacements of the thing they are posted to — they are operations on the
  // draft — so they are POST on their own paths rather than verbs smuggled into
  // a body the draft route would have to branch on.
  assert.deepEqual(methodsByPath["/api/admin/content/draft"], ["GET", "PUT"]);
  assert.deepEqual(methodsByPath["/api/admin/content/publish"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/content/reset"], ["POST"]);

  // Package 3.3. One path, three verbs, and no `{id}` segment: `Router` is
  // exact-path by construction, and the delete carries its id in the body for
  // the reason `mediaDeleteRequestSchema` documents.
  assert.deepEqual(methodsByPath["/api/admin/media"], ["GET", "POST", "DELETE"]);

  assert.ok(contract.errorCodes.includes("STORAGE_FAILURE"));
  assert.ok(contract.errorCodes.includes("PAYLOAD_TOO_LARGE"));
  assert.ok(contract.errorCodes.includes("MEDIA_REFERENCED"));
});

test("the generated HTTP contract carries the auth and CSRF boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    auth?: {
      sessionCookie: {
        name: string;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
        path: string;
        domain: null;
      };
      csrf: { header: string; failure: { status: number; errorCode: string } };
      loginFailure: { status: number; errorCode: string; appliesTo: string[] };
      identity: { pattern: string; passwordMinLength: number };
    };
    errorCodes: string[];
  };

  // ESZ-025/026 read their whole security posture out of this block rather than
  // agreeing with the frontend out of band, exactly as ESZ-021 does for the
  // injection ids above.
  const auth = contract.auth;
  assert.ok(auth, "http-contract.json declares no auth block");

  assert.equal(auth.sessionCookie.name, "__Host-eszter_session");
  assert.equal(auth.sessionCookie.httpOnly, true);
  assert.equal(auth.sessionCookie.secure, true);
  assert.equal(auth.sessionCookie.sameSite, "Strict");
  assert.equal(auth.sessionCookie.path, "/");
  assert.equal(auth.sessionCookie.domain, null);

  assert.equal(auth.csrf.header, "x-csrf-token");
  assert.equal(auth.csrf.failure.status, 403);
  assert.equal(auth.csrf.failure.errorCode, "CSRF_TOKEN_INVALID");

  // The three login failures share one outcome. If this list ever shrinks, one of
  // them has grown a distinguishable answer and become an enumeration oracle.
  assert.equal(auth.loginFailure.status, 401);
  assert.equal(auth.loginFailure.errorCode, "INVALID_CREDENTIALS");
  assert.deepEqual(auth.loginFailure.appliesTo, [
    "unknown email",
    "wrong password",
    "disabled account",
  ]);

  assert.ok(auth.identity.passwordMinLength >= 12);

  for (const code of [
    "VALIDATION_FAILED",
    "INVALID_CREDENTIALS",
    "UNAUTHENTICATED",
    "CSRF_TOKEN_INVALID",
  ]) {
    assert.ok(contract.errorCodes.includes(code), `${code} is missing from errorCodes`);
  }
});

test("the generated HTTP contract carries the public-page injection boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    publicPage?: {
      path: string;
      contentType: string;
      bootstrap: { contentElementId: string; appearanceElementId: string };
      fallback: { status: number };
    };
  };

  // ESZ-021 moved `/` from "not ours" to a contracted endpoint. A PHP
  // implementation reads the element ids from here rather than agreeing with the
  // frontend out of band, which is the whole point of the artifact.
  const publicPage = contract.publicPage;
  assert.ok(publicPage, "http-contract.json declares no publicPage block");
  assert.equal(publicPage.path, "/");
  assert.equal(publicPage.contentType, "text/html; charset=utf-8");
  assert.equal(publicPage.bootstrap.contentElementId, "__ESZTER_CONTENT__");
  assert.equal(publicPage.bootstrap.appearanceElementId, "__ESZTER_APPEARANCE__");

  // The page degrades to 200 with the baked defaults where the API answers 500.
  assert.equal(publicPage.fallback.status, 200);
});

test("no contract case is exempted from any implementation", () => {
  // ESZ-015 left exactly one exemption: `/` was not the PHP front controller's to
  // answer. ESZ-021 made it PHP's, so the case became a real endpoint and the
  // exemption went with it. The set is empty and must stay empty — an exemption is
  // a contract change, not a way to quiet a failing runtime.
  const exempted = httpContractCases
    .filter((httpCase) => (httpCase.exemptions?.length ?? 0) > 0)
    .map((httpCase) => httpCase.id);

  assert.deepEqual(exempted, []);
});

test("every public-page HTML case states which document it must render", () => {
  for (const httpCase of httpContractCases) {
    if (httpCase.expect.body !== "publicPageHtml") continue;

    assert.ok(
      httpCase.expect.pageContent === "published" || httpCase.expect.pageContent === "defaults",
      `${httpCase.id} asserts publicPageHtml without saying which document it carries`,
    );
  }
});

test("the generated HTTP contract carries the media boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    media?: {
      path: string;
      cacheControl: string;
      assetIdPattern: string;
      publicPathPrefix: string;
      publicPathPattern: string;
      formats: Array<{ mimeType: string; extension: string }>;
      upload: { fieldName: string; contentType: string; limitBytes: number };
      dimensions: { maxDimension: number; maxPixels: number };
      storage: {
        intake: { webReachable: boolean };
        original: { webReachable: boolean };
        managed: { webReachable: boolean };
      };
      ingest: { pipeline: string[]; requirements: string[] };
      delete: { refusal: { status: number; errorCode: string }; requirements: string[] };
    };
    errorCodes: string[];
    cases: Array<{ id: string; endpoint: string; request: { body?: string } }>;
  };

  const media = contract.media;
  assert.ok(media, "http-contract.json declares no media block");

  assert.equal(media.path, "/api/admin/media");
  // The library is a map of unpublished editorial work, exactly like the draft.
  assert.equal(media.cacheControl, "no-store");

  // The V1 allowlist, asserted as a set rather than as a length, so adding a
  // format is a deliberate edit to this line and not a silent widening. SVG in
  // particular is a scriptable document, not a bitmap, and must stay out.
  assert.deepEqual(
    media.formats.map((format) => format.mimeType).sort(),
    ["image/jpeg", "image/png", "image/webp"],
  );
  assert.deepEqual(
    media.formats.map((format) => format.extension).sort(),
    ["jpg", "png", "webp"],
  );
  for (const format of media.formats) {
    assert.ok(
      !/svg|xml/i.test(format.mimeType),
      "SVG is not a bitmap and must not be on the media allowlist",
    );
  }

  // Only the derivative is reachable. If either of the other two ever became
  // reachable, an unverified byte sequence would be addressable.
  assert.equal(media.storage.intake.webReachable, false);
  assert.equal(media.storage.original.webReachable, false);
  assert.equal(media.storage.managed.webReachable, true);

  // Every stored name is server-generated: the pattern admits no separator, no
  // dot beyond the extension and no client-supplied byte at all.
  assert.equal(media.assetIdPattern, "^med_[0-9a-f]{32}$");
  assert.equal(media.publicPathPrefix, "/media/");
  const publicPath = new RegExp(media.publicPathPattern);
  assert.ok(publicPath.test(`/media/med_${"0".repeat(32)}.jpg`));
  assert.ok(!publicPath.test(`/media/../med_${"0".repeat(32)}.jpg`));
  assert.ok(!publicPath.test(`/media/med_${"0".repeat(32)}.php.jpg`));
  assert.ok(!publicPath.test(`/media/med_${"0".repeat(32)}.svg`));

  // The route's own limit, and the global one it must not have moved.
  assert.equal(media.upload.fieldName, "file");
  assert.equal(media.upload.contentType, "multipart/form-data");
  assert.equal(media.upload.limitBytes, 8 * 1024 * 1024);
  assert.ok(contract.errorCodes.includes("PAYLOAD_TOO_LARGE"));
  assert.ok(contract.errorCodes.includes("MEDIA_REFERENCED"));

  // Dimensions are bounded before a decoder runs, which is the only ordering
  // that stops a decompression bomb rather than surviving one.
  const detect = media.ingest.pipeline.indexOf("boundDimensions");
  const decode = media.ingest.pipeline.indexOf("decode");
  assert.ok(detect >= 0 && decode >= 0);
  assert.ok(detect < decode, "dimensions must be bounded before decoding");

  // And the bytes decide the type, before the allowlist is consulted.
  const fromBytes = media.ingest.pipeline.indexOf("detectTypeFromBytes");
  const allowlist = media.ingest.pipeline.indexOf("assertAllowlisted");
  assert.ok(fromBytes >= 0 && fromBytes < allowlist);
  assert.ok(media.ingest.pipeline.indexOf("csrf") < fromBytes);

  // The delete refusal is its own code: a referenced asset is neither a
  // validation failure nor a revision conflict, and the recovery differs.
  assert.equal(media.delete.refusal.status, 409);
  assert.equal(media.delete.refusal.errorCode, "MEDIA_REFERENCED");
  assert.ok(
    media.delete.requirements.some((requirement) =>
      /draft/.test(requirement) && /published/.test(requirement),
    ),
    "the reference check must cover both the draft and the published document",
  );

  // Every media case that names a body names one the runner knows how to build.
  const named = new Set(contractRequestBodies as readonly string[]);
  for (const httpCase of contract.cases) {
    if (httpCase.endpoint !== "/api/admin/media") continue;
    if (httpCase.request.body === undefined) continue;
    assert.ok(
      named.has(httpCase.request.body),
      `${httpCase.id} names an unbuildable body ${httpCase.request.body}`,
    );
  }
});

test("the generated HTTP contract carries the admin content boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    adminContent?: {
      paths: { draft: string; publish: string; reset: string };
      cacheControl: string;
      revisionHeader: string;
      revision: {
        invariant: string;
        transitions: { saveDraft: string; publish: string; resetDraft: string };
      };
      concurrency: {
        field: string;
        failure: { status: number; errorCode: string };
        ignoredHeaders: string[];
        appliesTo: string[];
      };
      resetSources: string[];
      requestBodies: string[];
      staleRevisionFixture: number;
    };
    errorCodes: string[];
  };

  const admin = contract.adminContent;
  assert.ok(admin, "http-contract.json declares no adminContent block");

  assert.equal(admin.paths.draft, "/api/admin/content/draft");
  assert.equal(admin.paths.publish, "/api/admin/content/publish");
  assert.equal(admin.paths.reset, "/api/admin/content/reset");

  // Unpublished editorial work must not be storable by a browser or a proxy.
  // `no-cache` would permit exactly that and merely require revalidation.
  assert.equal(admin.cacheControl, "no-store");
  assert.equal(admin.revisionHeader, "x-content-revision");

  // The single shared sequence (ESZ-031/032/033). Publish setting
  // `published.revision` *to* the draft head — rather than incrementing a
  // counter of its own — is what makes a retry idempotent and what keeps the
  // published revision traceable to the draft it came from.
  assert.match(admin.revision.invariant, /published\.revision <= draft\.revision/);
  assert.match(admin.revision.transitions.saveDraft, /head \+ 1/);
  assert.match(admin.revision.transitions.publish, /published\.revision = draft\.revision/);
  // Reset is a draft mutation like any other; a head that did not move would
  // make it the one write the concurrency check cannot see.
  assert.match(admin.revision.transitions.resetDraft, /head \+ 1/);

  // Exactly one optimistic-concurrency mechanism, and the negative half is part
  // of the contract: a second way to state the precondition is a hole, because a
  // client using the one the server ignores is protected by nothing.
  assert.equal(admin.concurrency.field, "expectedRevision");
  assert.equal(admin.concurrency.failure.status, 409);
  assert.equal(admin.concurrency.failure.errorCode, "REVISION_CONFLICT");
  assert.ok(contract.errorCodes.includes("REVISION_CONFLICT"));
  for (const header of ["if-match", "if-unmodified-since", "if-none-match"]) {
    assert.ok(
      admin.concurrency.ignoredHeaders.includes(header),
      `${header} must be declared ignored on the admin content surface`,
    );
  }

  // All three writing routes are covered, so none of them is a lighter
  // operation that skips the precondition.
  assert.deepEqual([...admin.concurrency.appliesTo].sort(), [
    "POST /api/admin/content/publish",
    "POST /api/admin/content/reset",
    "PUT /api/admin/content/draft",
  ]);

  // A closed source enum: a destructive operation names what it resets to.
  assert.deepEqual(admin.resetSources, ["published"]);

  assert.ok(admin.requestBodies.length > 0);
  assert.ok(Number.isInteger(admin.staleRevisionFixture));
});

test("every admin content case names a body the runner can build", () => {
  const named = new Set(contractRequestBodies);

  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;

    const { body, rawBody } = httpCase.request;

    // Mutually exclusive: a case that supplied both would leave the runner to
    // pick, and the two would silently disagree about what was sent.
    assert.ok(
      !(body !== undefined && rawBody !== undefined),
      `${httpCase.id} supplies both a named body and a raw body`,
    );

    if (body !== undefined) {
      assert.ok(named.has(body), `${httpCase.id} names an unknown request body: ${body}`);
    }

    // A method that carries a body must say what it is, or the case proves
    // nothing about the route it exercises.
    if (["PUT", "POST"].includes(httpCase.request.method)) {
      assert.ok(
        body !== undefined || rawBody !== undefined,
        `${httpCase.id} is a ${httpCase.request.method} with no body at all`,
      );
    }
  }
});

test("every admin content write case states what it did to storage", () => {
  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;
    if (!["PUT", "POST"].includes(httpCase.request.method)) continue;
    // A malformed body is rejected before routing, so it is not a statement
    // about this surface's storage behaviour.
    if (httpCase.request.rawBody !== undefined) continue;

    assert.ok(
      httpCase.expect.storageAfter !== undefined,
      `${httpCase.id} writes to a mutating route without asserting the effect on storage`,
    );

    // The load-bearing half: every non-2xx on a write route must leave storage
    // alone. If one of these ever stopped saying `unchanged`, a rejected
    // request would have started mutating content.
    if (httpCase.expect.status >= 400) {
      assert.equal(
        httpCase.expect.storageAfter,
        "unchanged",
        `${httpCase.id} is a ${httpCase.expect.status} that does not leave storage unchanged`,
      );
    }
  }
});

test("no rejected admin content request reports the revision header", () => {
  // `content.rejectedRequestsNeverReachStorage`: a 401 or a 403 is decided
  // before the lock is taken, so it cannot know the head — and must not leak
  // that one exists. A 409 is the deliberate exception: it *is* the mechanism's
  // answer, and it carries the head so the caller can rebase.
  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;
    if (![401, 403].includes(httpCase.expect.status)) continue;
    if (httpCase.expect.contentRevision === undefined) continue;

    assert.equal(
      httpCase.expect.contentRevision,
      "absent",
      `${httpCase.id} is a ${httpCase.expect.status} that reports a content revision`,
    );
  }
});
