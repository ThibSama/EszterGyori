#!/usr/bin/env node
/**
 * ESZ-124 — focused policy tests for the fail-closed canonical validator
 * (`scripts/validate.mjs`).
 *
 * Negative proofs 1–6 are pure Node: synthetic gates are injected through
 * `runValidation({ declared, silent })` so no real gate runs and no stdout is
 * produced. Proof 7 — a failing full-stack smoke child must make canonical
 * validation fail — provisions the real disposable stack (ESZ-112 primitive)
 * and is skipped honestly when no Docker engine is reachable. The canonical
 * gate list itself is asserted statically: `php:smoke:full-stack` is a
 * required executable gate, and the only deferred gates are the two
 * deployment-owned ones the policy allowlist names.
 *
 * Run: node --test scripts/validate.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { dockerEngineAvailable } from "./sql-test-mysql.mjs";
import {
  DEFERRED_LIVE_GATES,
  gateDeclarationProblems,
  gates,
  runValidation,
  summarize,
} from "./validate.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const okCommand = ["node", "-e", "process.exit(0)"];
const failingCommand = ["node", "-e", "process.exit(3)"];

/** Builds one synthetic repo-owned gate for a policy case. */
function repoGate(id, extra = {}) {
  return { id, stage: "T", command: okCommand, ...extra };
}

async function run(declared, options = {}) {
  return runValidation({ declared, silent: true, ...options });
}

// ── Proofs 1–6: the fail-closed policy on synthetic gates ─────────────────

describe("ESZ-124 validate policy", () => {
  test("1. required PASS evidence permits local success", async () => {
    const gate = repoGate("t:pass");
    const outcome = await run([gate]);

    assert.equal(outcome.code, 0);
    assert.equal(outcome.summary.local.success, true);
    assert.equal(outcome.summary.passed, 1);
    assert.equal(outcome.summary.failed, 0);
    assert.equal(outcome.summary.deployment.deferred, 0);
    assert.deepEqual(outcome.report, [
      {
        id: "t:pass",
        stage: "T",
        required: true,
        deferred: false,
        ownership: "repo",
        status: "PASS",
        durationMs: outcome.report[0].durationMs,
      },
    ]);
  });

  test("2. required FAIL blocks local success", async () => {
    const gate = repoGate("t:fail", { command: failingCommand });
    const outcome = await run([gate]);

    assert.equal(outcome.code, 1);
    assert.equal(outcome.summary.local.success, false);
    assert.equal(outcome.summary.failed, 1);
    assert.deepEqual(outcome.summary.blocked, ["t:fail"]);
    const entry = outcome.report.find((item) => item.id === "t:fail");
    assert.equal(entry.status, "FAIL");
    assert.equal(entry.required, true);
    assert.equal(entry.deferred, false);
    assert.match(entry.detail, /exit 3/);
  });

  test("3. required NOT RUN blocks local success (never a pass, never exit 0)", async () => {
    const gate = repoGate("t:not-run", { unavailable: () => "the subject for t:not-run does not exist yet" });
    const outcome = await run([gate]);

    assert.equal(outcome.code, 1);
    assert.equal(outcome.summary.local.success, false);
    assert.equal(outcome.summary.requiredNotRun, 1);
    assert.equal(outcome.summary.local.notRun, 1);
    assert.deepEqual(outcome.summary.blocked, ["t:not-run"]);
    const entry = outcome.report.find((item) => item.id === "t:not-run");
    assert.equal(entry.status, "NOT RUN");
    assert.equal(entry.required, true);
    assert.match(entry.reason, /does not exist yet/);
    // The gate never ran.
    assert.equal(entry.durationMs, undefined);
  });

  test("4. required NOT VERIFIED and any declared non-PASS status are rejected fail-closed", async () => {
    // A declared status is not a declaration: on a required gate it is a
    // runner error (exit 2) before anything could pretend it is evidence.
    const declaredStatusVariants = [
      [{ id: "t:x", stage: "T", status: "NOT VERIFIED", reason: "we forgot to run it" }],
      [repoGate("t:y", { status: "NOT RUN", reason: "pre-declared out of running" })],
      [repoGate("t:z", { status: "PASS", reason: "pre-declared green" })],
      [repoGate("t:w", { status: "maybe" })],
    ];

    for (const declared of declaredStatusVariants) {
      const outcome = await run(declared);
      assert.equal(outcome.code, 2, `declared status must be a runner error for ${JSON.stringify(declared)}`);
      assert.ok(outcome.summary.problems.length > 0);
      assert.match(outcome.summary.problems.join("\n"), /declared statuses are not declarations|a repo-owned gate must declare an executable command/);
      assert.equal(outcome.report.length, 0, "nothing may run when the declarations are invalid");
    }

    // A deferred gate may not declare a status either.
    const deferredWithStatus = await run([
      { id: "smoke:deployed-http", stage: "8. HTTP smoke", deferred: true, ownership: "deployment", reason: "no origin", status: "NOT VERIFIED" },
    ]);
    assert.equal(deferredWithStatus.code, 2);

    // And an unknown runtime status fails closed in the aggregator even when
    // some future change produces one.
    const unknown = summarize([{ id: "t:weird", status: "NOT VERIFIED" }]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.local.success, false);
    assert.deepEqual(unknown.blocked, ["t:weird"]);
  });

  test("5. deferred deployment-owned NOT RUN stays visible but does not fail the local run", async () => {
    const outcome = await runValidation({
      ids: ["smoke:deployed-http", "security:config"],
      silent: true,
    });

    assert.equal(outcome.code, 0, "deferred deployment-owned evidence must not fail a local run");
    assert.equal(outcome.summary.local.success, true);
    assert.equal(outcome.summary.passed, 0, "deferred evidence is never counted as PASS");
    assert.equal(outcome.summary.notRun, 2);
    assert.equal(outcome.summary.requiredNotRun, 0);
    assert.equal(outcome.summary.deployment.deferred, 2);
    assert.deepEqual(outcome.summary.deployment.gates.sort(), ["security:config", "smoke:deployed-http"]);
    assert.equal(outcome.report.length, 2);
    for (const entry of outcome.report) {
      assert.equal(entry.status, "NOT RUN");
      assert.equal(entry.required, false);
      assert.equal(entry.deferred, true);
      assert.equal(entry.ownership, "deployment");
      assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, "deferred gates carry a reason");
      assert.equal(DEFERRED_LIVE_GATES.has(entry.id), true);
    }
  });

  test("6. misclassifying an executable/local gate as deferred is mechanically constrained", async () => {
    // An executable gate cannot be deferred to dodge its proof.
    const executableDeferred = await run([
      { id: "smoke:deployed-http", stage: "8. HTTP smoke", deferred: true, ownership: "deployment", reason: "no origin", command: okCommand },
    ]);
    assert.equal(executableDeferred.code, 2);
    assert.match(executableDeferred.summary.problems.join("\n"), /must not carry an executable command/);

    // A deferred gate outside the narrow allowlist is rejected: deferral is a
    // policy, not a metadata choice available to any gate.
    const broadenedDeferral = await run([
      { id: "security:filesystem", stage: "T", deferred: true, ownership: "deployment", reason: "temporarily unproven" },
    ]);
    assert.equal(broadenedDeferral.code, 2);
    assert.match(broadenedDeferral.summary.problems.join("\n"), /may be deferred/);

    // Deferral requires the deployment-owned category marker.
    const missingOwnership = await run([
      { id: "smoke:deployed-http", stage: "8. HTTP smoke", deferred: true, reason: "no origin" },
    ]);
    assert.equal(missingOwnership.code, 2);
    assert.match(missingOwnership.summary.problems.join("\n"), /ownership "deployment"/);

    // A deferred gate without a reason is rejected.
    const missingReason = await run([
      { id: "smoke:deployed-http", stage: "8. HTTP smoke", deferred: true, ownership: "deployment" },
    ]);
    assert.equal(missingReason.code, 2);
    assert.match(missingReason.summary.problems.join("\n"), /must carry a reason/);

    // The allowlist must be backed by real declarations in the canonical
    // list: deleting a deferred gate from it is caught as a policy problem.
    const orphanedAllowlist = gateDeclarationProblems(
      gates.filter((gate) => gate.id !== "security:config"),
      { completePolicy: true },
    );
    assert.ok(
      orphanedAllowlist.some((problem) => problem.includes("named by the policy allowlist but is not declared deferred")),
      orphanedAllowlist.join("\n"),
    );
  });
});

// ── Canonical gate list metadata ───────────────────────────────────────────

describe("ESZ-124 canonical gate declarations", () => {
  test("php:smoke:full-stack is a required executable gate on the canonical list", () => {
    const fullStack = gates.find((gate) => gate.id === "php:smoke:full-stack");
    assert.ok(fullStack, "php:smoke:full-stack must be declared");
    assert.deepEqual(fullStack.command, ["node", "scripts/smoke-full-stack.mjs"]);
    assert.notEqual(fullStack.deferred, true, "the full-stack smoke is repo-owned and required");
    assert.equal(fullStack.stage, "8. HTTP smoke");
    assert.ok(typeof fullStack.proves === "string" && fullStack.proves.includes("ESZ-124"));
  });

  test("the only deferred gates are exactly the deployment-owned allowlist", () => {
    const deferred = gates.filter((gate) => gate.deferred === true);
    assert.deepEqual(
      deferred.map((gate) => gate.id).sort(),
      [...DEFERRED_LIVE_GATES].sort(),
      "DEFERRED_LIVE_GATES must match the declared deferred gates exactly",
    );
    for (const gate of deferred) {
      assert.equal(gate.ownership, "deployment");
      assert.ok(typeof gate.reason === "string" && gate.reason !== "");
      assert.equal(gate.command, undefined);
    }
    // No gate may pre-declare an outcome of any kind.
    for (const gate of gates) {
      assert.equal(gate.status, undefined, `gate ${gate.id} must not declare a status`);
    }
  });

  test("the canonical declarations are valid (no declaration problems)", () => {
    assert.deepEqual(gateDeclarationProblems(gates), []);
  });
});

// ── Proof 7: a failing full-stack smoke child fails canonical validation ──

describe("ESZ-124 full-stack smoke as a canonical gate (needs Docker + PHP deps)", {
  skip: !(dockerEngineAvailable()
    && existsSync(join(repoRoot, "php", "vendor", "autoload.php"))
    && existsSync(join(repoRoot, "front", "out", "index.html")))
    && "no Docker engine, PHP vendor or frontend export is available",
}, () => {
  test("7. a failing full-stack smoke child makes canonical validation fail", async () => {
    // Seams: skip the frontend rebuild (out/ exists) and inject a failure
    // right after the disposable stack is live — the smoke must exit 1 after
    // cleaning up, and the gate must report FAIL.
    const previous = {
      skipBuild: process.env.ESZTER_FULL_STACK_SMOKE_SKIP_BUILD,
      failStep: process.env.ESZTER_FULL_STACK_SMOKE_FAIL_STEP,
    };
    process.env.ESZTER_FULL_STACK_SMOKE_SKIP_BUILD = "1";
    process.env.ESZTER_FULL_STACK_SMOKE_FAIL_STEP = "after-stack";

    try {
      const outcome = await runValidation({ ids: ["php:smoke:full-stack"], silent: true });

      assert.equal(outcome.code, 1, "a failing smoke child must fail canonical validation");
      assert.equal(outcome.summary.local.success, false);
      assert.equal(outcome.summary.failed, 1);
      assert.deepEqual(outcome.summary.blocked, ["php:smoke:full-stack"]);
      const entry = outcome.report.find((item) => item.id === "php:smoke:full-stack");
      assert.equal(entry.status, "FAIL");
      assert.equal(entry.required, true);
      assert.match(entry.output, /full-stack smoke: FAIL — injected failure/);
    } finally {
      if (previous.skipBuild === undefined) delete process.env.ESZTER_FULL_STACK_SMOKE_SKIP_BUILD;
      else process.env.ESZTER_FULL_STACK_SMOKE_SKIP_BUILD = previous.skipBuild;
      if (previous.failStep === undefined) delete process.env.ESZTER_FULL_STACK_SMOKE_FAIL_STEP;
      else process.env.ESZTER_FULL_STACK_SMOKE_FAIL_STEP = previous.failStep;
    }
  });
});
