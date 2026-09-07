#!/usr/bin/env node
/**
 * ESZ-116 — negative-proof suite for durable candidate evidence.
 *
 * These tests are offline and hermetic: every fixture is built in a temporary
 * directory, no gate is executed, no network is contacted, and the only Git
 * repository involved is a disposable one created here (its "remote" is
 * configuration text, never fetched). A bundle is generated from a synthetic
 * but structurally exact canonical validation report, and each test then
 * proves that ONE tampering is refused.
 *
 * The point of the suite is the refusals. A verifier that only says yes to
 * the bundle it just generated proves nothing, so every invariant that the
 * evidence rests on gets a case that breaks it:
 *
 *   - the bundle is bound to an exact repository and 40-hex commit;
 *   - a tampered validation report, artifact manifest or tarball is rejected;
 *   - a missing or non-PASS required gate is rejected;
 *   - both deployment-owned gates stay NOT RUN and cannot be promoted;
 *   - all eight baseline families must be present and supported;
 *   - a referenced gate id nothing declares is rejected;
 *   - the bundle digest catches an edited index;
 *   - nothing sensitive may appear in the index, and the durable report never
 *     persists child stdout/stderr.
 *
 * Run: `node --test scripts/evidence-bundle.test.mjs`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  BASELINE_FAMILIES,
  BUNDLE_FILES,
  EVIDENCE_BUNDLE_FORMAT,
  EXPLICIT_EVIDENCE_GATES,
  generateEvidenceBundle,
  sensitiveFieldProblems,
  verifyEvidenceBundle,
} from "./evidence-bundle.mjs";
import {
  DEFERRED_LIVE_GATES,
  VALIDATION_REPORT_FORMAT,
  durableValidationReport,
  gates,
  runValidation,
  summarize,
} from "./validate.mjs";
import { CANONICAL_REPOSITORY } from "./production-provenance.mjs";

const CANDIDATE_COMMIT = "8d87311991fb1657f1c44815ceac254563bd4e64";
const OTHER_COMMIT = "1111111111111111111111111111111111111111";

const scratchRoots = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `esz116-${prefix}-`));
  scratchRoots.push(dir);
  return dir;
}
after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** An all-green canonical run, shaped exactly as `runValidation` reports it. */
function greenGateResults() {
  return gates.map((gate) =>
    gate.deferred === true
      ? {
          id: gate.id,
          stage: gate.stage,
          required: false,
          deferred: true,
          ownership: "deployment",
          status: "NOT RUN",
          reason: gate.reason,
        }
      : {
          id: gate.id,
          stage: gate.stage,
          required: true,
          deferred: false,
          ownership: "repo",
          status: "PASS",
          durationMs: 1234,
        },
  );
}

function validationReportFixture({ commit = CANDIDATE_COMMIT, mutate = null } = {}) {
  const results = greenGateResults();
  const summary = summarize(results);
  const report = {
    format: VALIDATION_REPORT_FORMAT,
    candidate: { repository: CANONICAL_REPOSITORY, commit },
    local: summary.local,
    deployment: summary.deployment,
    counts: {
      passed: summary.passed,
      failed: summary.failed,
      notRun: summary.notRun,
      requiredNotRun: summary.requiredNotRun,
    },
    blocked: summary.blocked,
    gates: results,
  };
  return mutate ? (mutate(report) ?? report) : report;
}

function manifestFixture({ commit = CANDIDATE_COMMIT } = {}) {
  return {
    format: "eszter-production-artifact/v1",
    publicRoot: "public_html",
    phpMinimum: "8.2",
    nodeRuntimeRequired: false,
    provenance: {
      format: "eszter-production-provenance/v1",
      repository: CANONICAL_REPOSITORY,
      commit,
    },
    directories: ["app", "public_html"],
    files: { "public_html/index.html": { bytes: 12, mode: "0644", sha256: "0".repeat(64) } },
  };
}

/**
 * Build a complete bundle on disk. Returns the bundle directory plus helpers
 * for the two tampering styles: editing the index and resealing its digest
 * (which isolates one invariant), or editing a payload file (which the
 * recorded per-file digests must catch).
 */
function makeBundle({ report = validationReportFixture(), manifest = manifestFixture(), env = {} } = {}) {
  const root = scratch("bundle");
  const reportPath = join(root, "validation-report.json");
  const manifestPath = join(root, "ARTIFACT-MANIFEST.json");
  const tarballPath = join(root, "eszter-production.tar.gz");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(tarballPath, "deterministic archive bytes for hashing");

  const outDir = join(root, "bundle");
  const result = generateEvidenceBundle({ outDir, reportPath, manifestPath, tarballPath, env });
  return { ...result, root, outDir, reportPath, manifestPath, tarballPath };
}

function readIndex(outDir) {
  return JSON.parse(readFileSync(join(outDir, BUNDLE_FILES.index), "utf8"));
}

/** Rewrite index.json and reseal bundle.sha256, so only the edit is under test. */
function rewriteIndex(outDir, index) {
  const serialised = `${JSON.stringify(index, null, 2)}\n`;
  writeFileSync(join(outDir, BUNDLE_FILES.index), serialised);
  const digest = createHash("sha256").update(serialised).digest("hex");
  writeFileSync(join(outDir, BUNDLE_FILES.bundleDigest), `${digest}  ${BUNDLE_FILES.index}\n`);
}

const trusted = { expectedRepository: CANONICAL_REPOSITORY, expectedCommit: CANDIDATE_COMMIT };

function verify(outDir, expectations = trusted) {
  return verifyEvidenceBundle(outDir, expectations);
}

function assertRejected(problems, needle) {
  assert.ok(problems.length > 0, "expected verification to report at least one problem");
  assert.ok(
    problems.some((problem) => problem.includes(needle)),
    `expected a problem mentioning ${JSON.stringify(needle)}, got:\n  ${problems.join("\n  ")}`,
  );
}

describe("ESZ-116 candidate evidence — the happy path is complete", () => {
  test("a generated bundle verifies, and carries every kind of required evidence", () => {
    const { outDir, index } = makeBundle();

    assert.equal(verify(outDir).length, 0);
    assert.equal(index.format, EVIDENCE_BUNDLE_FORMAT);
    assert.equal(index.candidate.repository, CANONICAL_REPOSITORY);
    assert.equal(index.candidate.commit, CANDIDATE_COMMIT);

    // Every declared gate is present, not a filtered subset.
    assert.equal(index.gates.length, gates.length);

    // Local quality is stated, and release state is a separate structure that
    // local success never feeds.
    assert.equal(index.localQuality.success, true);
    assert.equal(index.deployment.releaseReady, false);
    assert.equal(index.deployment.deployedHostEvidence, "pending");

    // Artifact provenance and tarball digest.
    assert.equal(index.artifact.provenance.commit, CANDIDATE_COMMIT);
    assert.match(index.artifact.tarball.sha256, /^[0-9a-f]{64}$/);

    // Explicit evidence for the expensive gates, and all eight families.
    assert.deepEqual(
      index.explicitEvidence.map((entry) => entry.id).sort(),
      [...EXPLICIT_EVIDENCE_GATES].sort(),
    );
    assert.deepEqual(
      index.baselines.map((baseline) => baseline.family).sort(),
      ["Architecture", "Data", "Delivery", "Operations", "Performance", "Quality", "Security", "Testing"],
    );
    assert.equal(index.baselines.length, 8);
  });

  test("the SQL, full-stack, Apache, browser and packaging gates are each named explicitly", () => {
    const { index } = makeBundle();
    const named = new Set(index.explicitEvidence.map((entry) => entry.id));
    for (const id of [
      "sql:migrations",
      "sql:integration",
      "sql:rate-limits",
      "sql:backup-restore",
      "sql:notifications",
      "php:smoke:full-stack",
      "smoke:apache",
      "browser:public",
      "browser:admin",
      "browser:booking",
      "browser:admin-auth",
      "browser:admin-preview-csp",
      "browser:media-pipeline",
      "browser:admin-booking-contact",
      "deployment:artifact",
    ]) {
      assert.ok(named.has(id), `${id} must be named explicitly in the evidence index`);
    }
  });

  test("the bundle may be generated in place, over the directory holding the report", () => {
    // This is the CI layout: the canonical report is written into the same
    // directory the bundle is generated into, so the uploaded Actions artifact
    // IS the bundle. The report must survive being its own payload file.
    const root = scratch("inplace");
    const reportPath = join(root, BUNDLE_FILES.validationReport);
    const manifestPath = join(root, "ARTIFACT-MANIFEST.json");
    const tarballPath = join(root, "source.tar.gz");
    const reportBytes = `${JSON.stringify(validationReportFixture(), null, 2)}\n`;
    writeFileSync(reportPath, reportBytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifestFixture(), null, 2)}\n`);
    writeFileSync(tarballPath, "archive bytes");

    generateEvidenceBundle({ outDir: root, reportPath, manifestPath, tarballPath, env: {} });

    assert.equal(readFileSync(reportPath, "utf8"), reportBytes, "the report must not be truncated by copying onto itself");
    assert.deepEqual(verify(root), []);
  });

  test("outside GitHub Actions the CI block is honestly absent, and inside it is bound to the candidate", () => {
    assert.equal(makeBundle().index.ci.present, false);

    const { index } = makeBundle({
      env: {
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_NUMBER: "7",
        GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_WORKFLOW: "Eszter Quality",
        GITHUB_JOB: "quality-gate",
        GITHUB_SHA: CANDIDATE_COMMIT,
      },
    });
    assert.equal(index.ci.present, true);
    assert.equal(index.ci.workflow, "Eszter Quality");
    assert.equal(index.ci.job, "quality-gate");
    assert.equal(index.ci.runId, "42");
    assert.equal(index.ci.runAttempt, "2");
    assert.equal(index.ci.headSha, CANDIDATE_COMMIT);
    assert.equal(index.ci.runUrl, `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/42/attempts/2`);
  });
});

describe("ESZ-116 candidate evidence — repository and commit binding", () => {
  test("a bundle for another commit is refused against the attested SHA", () => {
    const { outDir } = makeBundle();
    assertRejected(
      verify(outDir, { expectedRepository: CANONICAL_REPOSITORY, expectedCommit: OTHER_COMMIT }),
      "does not match attested commit",
    );
  });

  test("a non-canonical repository is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.candidate.repository = "someone-else/EszterGyori";
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), `candidate repository is not ${CANONICAL_REPOSITORY}`);
  });

  test("a short or non-hex commit is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.candidate.commit = "8d87311";
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir, { ...trusted, expectedCommit: "8d87311" }), "40-character lowercase hex SHA");
  });

  test("verification without a trusted expectation fails closed rather than trusting the bundle", () => {
    const { outDir } = makeBundle();
    assertRejected(
      verifyEvidenceBundle(outDir, { expectedRepository: null, expectedCommit: null }),
      "no trusted expected repository/commit",
    );
  });

  test("a CI head SHA that disagrees with the validated candidate is refused at generation", () => {
    assert.throws(
      () =>
        makeBundle({
          env: {
            GITHUB_RUN_ID: "42",
            GITHUB_REPOSITORY: CANONICAL_REPOSITORY,
            GITHUB_SHA: OTHER_COMMIT,
          },
        }),
      /CI head SHA .* does not match the validated candidate/,
    );
  });
});

describe("ESZ-116 candidate evidence — tampering is detected", () => {
  test("editing the bundled validation report breaks its recorded digest", () => {
    const { outDir } = makeBundle();
    appendFileSync(join(outDir, BUNDLE_FILES.validationReport), "\n");
    assertRejected(verify(outDir), `referenced file ${BUNDLE_FILES.validationReport} does not match`);
  });

  test("editing the bundled artifact manifest breaks its recorded digest", () => {
    const { outDir } = makeBundle();
    appendFileSync(join(outDir, BUNDLE_FILES.artifactManifest), "\n");
    assertRejected(verify(outDir), `referenced file ${BUNDLE_FILES.artifactManifest} does not match`);
  });

  test("replacing the production tarball is refused", () => {
    const { outDir } = makeBundle();
    writeFileSync(join(outDir, BUNDLE_FILES.tarball), "a different archive entirely");
    const problems = verify(outDir);
    assertRejected(problems, "production tarball does not match the recorded SHA-256");
  });

  test("removing a referenced file is refused", () => {
    const { outDir } = makeBundle();
    rmSync(join(outDir, BUNDLE_FILES.markdown));
    assertRejected(verify(outDir), `referenced file is missing from the bundle: ${BUNDLE_FILES.markdown}`);
  });

  test("editing index.json without resealing is caught by the bundle digest", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.localQuality.scope = "quietly reworded";
    // Deliberately NOT resealing bundle.sha256.
    writeFileSync(join(outDir, BUNDLE_FILES.index), `${JSON.stringify(index, null, 2)}\n`);
    assertRejected(verify(outDir), `bundle digest does not match ${BUNDLE_FILES.index}`);
  });

  test("an artifact packaged from another commit cannot be presented as this candidate", () => {
    assert.throws(
      () => makeBundle({ manifest: manifestFixture({ commit: OTHER_COMMIT }) }),
      /artifact provenance does not attest this candidate/,
    );
  });

  test("a bundled report attesting a different commit than the index is refused", () => {
    const { outDir } = makeBundle();
    const report = JSON.parse(readFileSync(join(outDir, BUNDLE_FILES.validationReport), "utf8"));
    report.candidate.commit = OTHER_COMMIT;
    const serialised = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(outDir, BUNDLE_FILES.validationReport), serialised);
    const index = readIndex(outDir);
    const entry = index.files.find((file) => file.path === BUNDLE_FILES.validationReport);
    entry.sha256 = createHash("sha256").update(serialised).digest("hex");
    entry.bytes = Buffer.byteLength(serialised);
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), `bundled validation report attests ${OTHER_COMMIT}`);
  });
});

describe("ESZ-116 candidate evidence — gate invariants", () => {
  test("a non-PASS required gate is refused at generation and at verification", () => {
    // The generator only refuses on structural grounds, so the bundle is
    // produced; verification is where a red required gate is caught.
    const { outDir } = makeBundle({
      report: validationReportFixture({
        mutate: (report) => {
          const gate = report.gates.find((entry) => entry.id === "php:unit");
          gate.status = "FAIL";
          gate.detail = "exit 1";
          report.local = { ...report.local, success: false };
        },
      }),
    });
    assertRejected(verify(outDir), "required gate php:unit did not PASS: FAIL");
  });

  test("a required gate left NOT RUN is refused", () => {
    const { outDir } = makeBundle({
      report: validationReportFixture({
        mutate: (report) => {
          const gate = report.gates.find((entry) => entry.id === "sql:migrations");
          gate.status = "NOT RUN";
          gate.reason = "no database";
        },
      }),
    });
    assertRejected(verify(outDir), "required gate sql:migrations did not PASS: NOT RUN");
  });

  test("a missing explicit-evidence gate is refused at generation", () => {
    assert.throws(
      () =>
        makeBundle({
          report: validationReportFixture({
            mutate: (report) => {
              report.gates = report.gates.filter((entry) => entry.id !== "smoke:apache");
            },
          }),
        }),
      /explicit evidence gate smoke:apache is absent from the validation report/,
    );
  });

  test("dropping a gate from the index after generation is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates = index.gates.filter((gate) => gate.id !== "php:smoke:full-stack");
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "explicit evidence names unknown gate id php:smoke:full-stack");
  });

  test("an explicit-evidence entry that contradicts its gate result is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates.find((gate) => gate.id === "smoke:apache").status = "FAIL";
    rewriteIndex(outDir, index);
    const problems = verify(outDir);
    assertRejected(problems, "explicit evidence for smoke:apache claims PASS, the gate result says FAIL");
  });

  test("an index gate that the bundled validation report does not contain is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates.push({
      id: "invented:gate",
      stage: "1. Static integrity",
      status: "PASS",
      required: true,
      deferred: false,
      ownership: "repo",
    });
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "index gate invented:gate does not exist in the bundled validation report");
  });

  test("a gate that is neither required nor deferred is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates.find((gate) => gate.id === "front:lint").required = false;
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "is neither required nor deferred");
  });
});

describe("ESZ-116 candidate evidence — deferred deployment gates stay NOT RUN", () => {
  test("both deployment-owned gates are present, NOT RUN and never a release claim", () => {
    const { index } = makeBundle();
    assert.equal(index.deployment.deferredCount, 2);
    assert.deepEqual(
      index.deployment.deferredGates.map((gate) => gate.id).sort(),
      [...DEFERRED_LIVE_GATES].sort(),
    );
    for (const gate of index.deployment.deferredGates) {
      assert.equal(gate.status, "NOT RUN");
      assert.equal(gate.ownership, "deployment");
    }
    assert.equal(index.deployment.releaseReady, false);
  });

  test("promoting a deferred gate to PASS is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates.find((gate) => gate.id === "smoke:deployed-http").status = "PASS";
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "deferred gate smoke:deployed-http must remain NOT RUN, found PASS");
  });

  test("dropping a deferred gate from the index is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates = index.gates.filter((gate) => gate.id !== "security:config");
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "deferred gates must be exactly");
  });

  test("claiming release readiness from local success is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.deployment.releaseReady = true;
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "deployment.releaseReady must be false");
  });

  test("declaring deployed-host evidence anything but pending is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.deployment.deployedHostEvidence = "complete";
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "deployment.deployedHostEvidence must be");
  });
});

describe("ESZ-116 candidate evidence — baseline families", () => {
  test("all eight applicable families are declared with their domain prefixes", () => {
    const { index } = makeBundle();
    assert.deepEqual(
      index.baselines.map((baseline) => [baseline.family, baseline.domainPrefix]).sort(),
      [
        ["Architecture", "ARCH"],
        ["Data", "DATA"],
        ["Delivery", "DEL"],
        ["Operations", "OPS"],
        ["Performance", "PERF"],
        ["Quality", "QUAL"],
        ["Security", "SEC"],
        ["Testing", "TEST"],
      ],
    );
  });

  test("every family maps at least one gate, and every mapped gate exists and passed", () => {
    const { index } = makeBundle();
    const byId = new Map(index.gates.map((gate) => [gate.id, gate]));
    for (const baseline of index.baselines) {
      assert.ok(baseline.gateIds.length > 0, `${baseline.family} maps no gate`);
      for (const id of baseline.gateIds) {
        assert.ok(byId.has(id), `${baseline.family} maps unknown gate ${id}`);
        assert.equal(byId.get(id).status, "PASS");
      }
    }
  });

  test("removing a family is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.baselines = index.baselines.filter((baseline) => baseline.family !== "Performance");
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "baseline family Performance is missing from the index");
  });

  test("a family mapped to an unknown gate id is refused", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.baselines.find((baseline) => baseline.family === "Data").gateIds.push("sql:imaginary");
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "baseline Data maps unknown gate id sql:imaginary");
  });

  test("the declared mapping only ever names gates the canonical policy declares", () => {
    const declared = new Set(gates.map((gate) => gate.id));
    for (const family of BASELINE_FAMILIES) {
      for (const id of family.gateIds) {
        assert.ok(declared.has(id), `${family.family} maps ${id}, which no canonical gate declares`);
      }
    }
    for (const id of EXPLICIT_EVIDENCE_GATES) {
      assert.ok(declared.has(id), `explicit evidence names ${id}, which no canonical gate declares`);
    }
  });
});

describe("ESZ-116 candidate evidence — nothing sensitive is published", () => {
  test("a generated index carries no sensitive field", () => {
    const { index } = makeBundle();
    assert.deepEqual(sensitiveFieldProblems(index), []);
    assert.equal(verify(makeBundle().outDir).length, 0);
  });

  test("the scan catches credentials, addresses and debt wording wherever they hide", () => {
    assert.ok(sensitiveFieldProblems({ password: "x" }).length > 0);
    assert.ok(sensitiveFieldProblems({ nested: { csrfToken: "x" } }).length > 0);
    assert.ok(sensitiveFieldProblems({ note: "contact eszter@example.com" }).length > 0);
    assert.ok(sensitiveFieldProblems({ note: "mysql://root@127.0.0.1/db" }).length > 0);
    assert.ok(sensitiveFieldProblems({ note: "Set-Cookie: sid=abc" }).length > 0);
    assert.ok(sensitiveFieldProblems({ note: "Authorization: Bearer abcdefghij" }).length > 0);
    assert.ok(sensitiveFieldProblems({ note: "remaining acceptance debt: 3 items" }).length > 0);
    assert.deepEqual(sensitiveFieldProblems({ id: "smoke:apache", status: "PASS" }), []);
  });

  test("a sensitive value smuggled into a gate detail is refused at generation", () => {
    assert.throws(
      () =>
        makeBundle({
          report: validationReportFixture({
            mutate: (report) => {
              report.gates.find((entry) => entry.id === "php:unit").detail = "failed for admin@example.com";
            },
          }),
        }),
      /sensitive fields/,
    );
  });

  test("a sensitive value added to the index after generation is refused at verification", () => {
    const { outDir } = makeBundle();
    const index = readIndex(outDir);
    index.gates.find((gate) => gate.id === "php:unit").detail = "mysql://root:hunter2@db/eszter";
    rewriteIndex(outDir, index);
    assertRejected(verify(outDir), "sensitive content");
  });
});

describe("ESZ-116 report capture — the durable report is bounded and Git-derived", () => {
  /** A disposable checkout whose "remote" is configuration text, never fetched. */
  function disposableCheckout() {
    const dir = scratch("checkout");
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "--quiet");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("remote", "add", "origin", `https://github.com/${CANONICAL_REPOSITORY}`);
    writeFileSync(join(dir, "file.txt"), "content\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return { dir, head: git("rev-parse", "HEAD") };
  }

  test("the report binds the canonical repository and the Git HEAD of the checkout", () => {
    const { dir, head } = disposableCheckout();
    const results = greenGateResults();
    const report = durableValidationReport(results, summarize(results), { cwd: dir });
    assert.equal(report.format, VALIDATION_REPORT_FORMAT);
    assert.equal(report.candidate.repository, CANONICAL_REPOSITORY);
    assert.equal(report.candidate.commit, head);
    assert.match(report.candidate.commit, /^[0-9a-f]{40}$/);
  });

  test("arbitrary child stdout/stderr never reaches the durable report", () => {
    const { dir } = disposableCheckout();
    const results = greenGateResults();
    const failing = results.find((entry) => entry.id === "php:unit");
    failing.status = "FAIL";
    failing.detail = "exit 1";
    // What a real failing gate carries in memory: a transcript that may hold
    // anything a third-party tool decided to print.
    failing.output = "PHPUnit output\nAuthorization: Bearer sekrit\ncustomer@example.com\n";

    const report = durableValidationReport(results, summarize(results), { cwd: dir });
    const entry = report.gates.find((gate) => gate.id === "php:unit");
    assert.equal(entry.status, "FAIL");
    assert.equal(entry.detail, "exit 1");
    assert.equal(entry.output, undefined);
    assert.ok(!JSON.stringify(report).includes("sekrit"));
    assert.ok(!JSON.stringify(report).includes("customer@example.com"));
    assert.deepEqual(sensitiveFieldProblems(report), []);
  });

  test("stable failure metadata is flattened and bounded", () => {
    const { dir } = disposableCheckout();
    const results = greenGateResults();
    const failing = results.find((entry) => entry.id === "sql:migrations");
    failing.status = "FAIL";
    failing.detail = `line one\nline two\t${"x".repeat(900)}`;

    const report = durableValidationReport(results, summarize(results), { cwd: dir });
    const detail = report.gates.find((gate) => gate.id === "sql:migrations").detail;
    assert.ok(detail.length <= 500, `detail is ${detail.length} characters`);
    assert.ok(!detail.includes("\n"), "detail must be one line");
    assert.ok(detail.startsWith("line one line two"));
  });

  test("a failed run still produces a report whose failed state is explicit", () => {
    const { dir } = disposableCheckout();
    const results = greenGateResults();
    results.find((entry) => entry.id === "front:lint").status = "FAIL";
    const summary = summarize(results);
    const report = durableValidationReport(results, summary, { cwd: dir });

    assert.equal(report.local.success, false);
    assert.ok(report.blocked.includes("front:lint"));
    assert.equal(report.counts.failed, 1);
    // And the deferred gates are still reported as deferred, not as failures.
    assert.deepEqual(report.deployment.gates.sort(), [...DEFERRED_LIVE_GATES].sort());
  });

  test("the deferred gates keep their policy metadata in the durable report", () => {
    const { dir } = disposableCheckout();
    const results = greenGateResults();
    const report = durableValidationReport(results, summarize(results), { cwd: dir });
    for (const id of DEFERRED_LIVE_GATES) {
      const gate = report.gates.find((entry) => entry.id === id);
      assert.equal(gate.status, "NOT RUN");
      assert.equal(gate.deferred, true);
      assert.equal(gate.required, false);
      assert.equal(gate.ownership, "deployment");
      assert.ok(typeof gate.reason === "string" && gate.reason.length > 0);
    }
  });
});

describe("ESZ-116 report capture — plumbing preserves console and exit semantics", () => {
  // Two synthetic repo-owned gates, one passing and one failing, so the
  // capture is exercised through the real runner rather than around it. The
  // canonical gate list is never run here: this is about the report file.
  const passing = {
    id: "fixture:pass",
    stage: "0. Fixture",
    cwd: ".",
    command: ["node", "-e", ""],
    proves: "a synthetic gate that exits 0",
  };
  const failing = {
    id: "fixture:fail",
    stage: "0. Fixture",
    cwd: ".",
    command: ["node", "-e", "process.exit(3)"],
    proves: "a synthetic gate that exits non-zero",
  };

  test("--report/reportPath records the execution and leaves the exit code alone", async () => {
    const dir = scratch("capture");
    const reportPath = join(dir, "nested", "validation-report.json");

    const withReport = await runValidation({ declared: [passing], silent: true, reportPath });
    const withoutReport = await runValidation({ declared: [passing], silent: true });

    assert.equal(withReport.code, 0);
    assert.equal(withReport.code, withoutReport.code, "capturing a report must not change the exit code");

    // The parent directory is created; the write is atomic, so no .tmp remains.
    const written = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(written.format, VALIDATION_REPORT_FORMAT);
    assert.equal(written.candidate.repository, CANONICAL_REPOSITORY);
    assert.match(written.candidate.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(written.gates.map((gate) => gate.id), ["fixture:pass"]);
    assert.equal(written.gates[0].status, "PASS");
    assert.equal(written.local.success, true);
  });

  test("the ESZTER_VALIDATION_REPORT environment form is equivalent", async () => {
    const dir = scratch("capture-env");
    const reportPath = join(dir, "validation-report.json");
    const previous = process.env.ESZTER_VALIDATION_REPORT;
    process.env.ESZTER_VALIDATION_REPORT = reportPath;
    try {
      const result = await runValidation({ declared: [passing], silent: true });
      assert.equal(result.code, 0);
    } finally {
      if (previous === undefined) delete process.env.ESZTER_VALIDATION_REPORT;
      else process.env.ESZTER_VALIDATION_REPORT = previous;
    }
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).format, VALIDATION_REPORT_FORMAT);
  });

  test("a failed run still exits 1 and retains a report that states its own failure", async () => {
    const dir = scratch("capture-fail");
    const reportPath = join(dir, "validation-report.json");

    const result = await runValidation({ declared: [passing, failing], silent: true, reportPath });
    assert.equal(result.code, 1, "evidence capture must never turn a red run green");

    const written = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(written.local.success, false);
    assert.ok(written.blocked.includes("fixture:fail"));
    assert.equal(written.counts.failed, 1);
    assert.equal(written.gates.find((gate) => gate.id === "fixture:fail").status, "FAIL");
    // Stable metadata only — the child's own output is never persisted.
    assert.equal(written.gates.find((gate) => gate.id === "fixture:fail").output, undefined);
    assert.equal(written.gates.find((gate) => gate.id === "fixture:fail").detail, "exit 3");
    assert.deepEqual(sensitiveFieldProblems(written), []);
  });

  test("such a partial report cannot be turned into a passing evidence bundle", () => {
    const { outDir } = makeBundle({
      report: validationReportFixture({
        mutate: (report) => {
          report.gates.find((entry) => entry.id === "front:build").status = "FAIL";
          report.local = { ...report.local, success: false };
          report.blocked = ["front:build"];
        },
      }),
    });
    const problems = verify(outDir);
    assertRejected(problems, "required gate front:build did not PASS");
    assertRejected(problems, "local quality is not a success");
  });
});
