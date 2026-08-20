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
import { httpContractCases } from "../http-contract.js";

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
    ["/", "/api/content", "/api/health"],
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

  assert.ok(contract.errorCodes.includes("STORAGE_FAILURE"));
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
