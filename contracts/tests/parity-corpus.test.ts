import assert from "node:assert/strict";
import test from "node:test";
import {
  buildParityDocument,
  createParityBase,
  resolveJsonPointer,
  runParityCase,
} from "../parity-runtime.js";
import {
  publishedContentEnvelopeV1Schema,
  siteContentSchema,
} from "../index.js";
import { parityCases, semanticRules } from "../semantic-rules.js";

/**
 * Proves the Zod reference implementation agrees with the published parity
 * corpus. A future PHP implementation runs the same corpus from
 * `generated/parity-corpus.json` and must produce identical outcomes.
 */

function sorted(values: string[]): string[] {
  return [...values].sort();
}

test("both corpus base documents validate as-is", () => {
  // Also the proof that `null` media sources are accepted: every media source
  // in the canonical content is null, so no separate case is needed.
  siteContentSchema.parse(createParityBase("siteContent"));
  publishedContentEnvelopeV1Schema.parse(createParityBase("publishedEnvelope"));
});

test("every parity case id is unique", () => {
  const ids = parityCases.map((parityCase) => parityCase.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every parity case references a declared semantic rule", () => {
  const ruleIds = new Set(semanticRules.map((rule) => rule.id));
  for (const parityCase of parityCases) {
    assert.ok(
      ruleIds.has(parityCase.rule),
      `${parityCase.id} references unknown rule ${parityCase.rule}`,
    );
  }
});

test("invalid cases declare the issue paths they expect", () => {
  for (const parityCase of parityCases) {
    if (parityCase.expect !== "invalid") continue;
    assert.ok(
      parityCase.expectedIssuePaths && parityCase.expectedIssuePaths.length > 0,
      `${parityCase.id} must declare expectedIssuePaths`,
    );
  }
});

for (const parityCase of parityCases) {
  test(`parity: ${parityCase.id}`, () => {
    const result = runParityCase(parityCase);

    assert.equal(
      result.valid,
      parityCase.expect === "valid",
      `${parityCase.id}: expected ${parityCase.expect}, got ${
        result.valid ? "valid" : `invalid (${result.issuePaths.join(", ")})`
      }`,
    );

    if (parityCase.expect === "invalid") {
      assert.deepEqual(
        sorted(result.issuePaths),
        sorted(parityCase.expectedIssuePaths ?? []),
        `${parityCase.id}: issue paths diverged`,
      );
      return;
    }

    for (const [pointer, expected] of Object.entries(
      parityCase.expectedNormalization ?? {},
    )) {
      assert.deepEqual(
        resolveJsonPointer(result.parsed, pointer),
        expected,
        `${parityCase.id}: ${pointer} was not normalized as declared`,
      );
    }
  });
}

test("patches actually change the base document", () => {
  for (const parityCase of parityCases) {
    const patched = JSON.stringify(buildParityDocument(parityCase));
    const base = JSON.stringify(
      buildParityDocument({ ...parityCase, patch: [] }),
    );
    assert.notEqual(
      patched,
      base,
      `${parityCase.id}: patch is a no-op, so the case proves nothing`,
    );
  }
});
