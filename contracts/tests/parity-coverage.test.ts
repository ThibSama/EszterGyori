import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parityCases, semanticRules } from "../semantic-rules.js";

/**
 * Guards the ESZ-003 promise: no Zod rule may exist without a language-neutral
 * counterpart. Structural rules land in the generated JSON Schema; everything
 * else must be declared in `semanticRules` and exercised by parity cases.
 */

const CONTRACTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Frozen census of refinement/transform sites in the schema sources. Adding a
 * `.refine`, `.superRefine` or `.transform` moves a number here and forces the
 * author to decide how the new semantics reach a non-TypeScript consumer.
 */
const REFINEMENT_CENSUS: Record<
  string,
  { refine: number; superRefine: number; transform: number }
> = {
  "site-content.ts": { refine: 3, superRefine: 13, transform: 0 },
  "appearance.ts": { refine: 0, superRefine: 1, transform: 1 },
  "content-envelopes.ts": { refine: 1, superRefine: 0, transform: 0 },
};

test("every semantic rule is exercised by at least one parity case", () => {
  const covered = new Set(parityCases.map((parityCase) => parityCase.rule));

  const uncovered = semanticRules
    .map((rule) => rule.id)
    .filter((ruleId) => !covered.has(ruleId));

  assert.deepEqual(
    uncovered,
    [],
    `Semantic rules without parity coverage: ${uncovered.join(", ")}`,
  );
});

test("every semantic rule has at least one rejecting case", () => {
  const rejecting = new Set(
    parityCases
      .filter((parityCase) => parityCase.expect === "invalid")
      .map((parityCase) => parityCase.rule),
  );

  // Normalization rules describe an accepted-and-rewritten input rather than a
  // rejection, so they are legitimately proven by `valid` cases alone.
  const normalizationOnlyRules = new Set([
    "appearance.hexUppercaseNormalization",
    "appearance.defaultInjectionForLegacyContent",
  ]);

  const missing = semanticRules
    .map((rule) => rule.id)
    .filter((ruleId) => !rejecting.has(ruleId) && !normalizationOnlyRules.has(ruleId));

  assert.deepEqual(
    missing,
    [],
    `Semantic rules with no invalid case: ${missing.join(", ")}`,
  );
});

test("normalization rules declare the value they normalize to", () => {
  const normalizationCases = parityCases.filter(
    (parityCase) =>
      parityCase.rule === "appearance.hexUppercaseNormalization" ||
      parityCase.rule === "appearance.defaultInjectionForLegacyContent",
  );

  assert.ok(normalizationCases.length >= 2);
  for (const parityCase of normalizationCases) {
    assert.ok(
      Object.keys(parityCase.expectedNormalization ?? {}).length > 0,
      `${parityCase.id} must declare expectedNormalization`,
    );
  }
});

test("no unregistered refinement was added to the schema sources", async () => {
  for (const [fileName, expected] of Object.entries(REFINEMENT_CENSUS)) {
    const source = await readFile(join(CONTRACTS_ROOT, fileName), "utf8");

    const actual = {
      refine: source.match(/\.refine\(/g)?.length ?? 0,
      superRefine: source.match(/\.superRefine\(/g)?.length ?? 0,
      transform: source.match(/\.transform\(/g)?.length ?? 0,
    };

    assert.deepEqual(
      actual,
      expected,
      `${fileName}: refinement census changed. Declare the new semantics in semantic-rules.ts, add parity cases, then update REFINEMENT_CENSUS.`,
    );
  }
});
