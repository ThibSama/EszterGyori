#!/usr/bin/env node
/**
 * ESZ-143 — the deployment runbook, executed.
 *
 * Two defects motivated this suite, and each has a test here that fails
 * against the implementation that preceded it:
 *
 *   1. `docs/deployment-runbook.md` documented `npm run package:production`
 *      and `npm run verify:production-artifact`. Neither script has ever
 *      existed. A grep would not have noticed — the strings were perfectly
 *      present in the document — so the procedure is parsed out of the
 *      runbook and *run*, verbatim, in a clean checkout that owns no
 *      pre-existing build output.
 *
 *   2. The packager copied whatever `front/out` happened to hold. That
 *      directory is ignored by Git, so it takes no part in the ESZ-126 source
 *      identity: an export built from commit A could be packaged, and
 *      truthfully attested, as commit B. The stale-output tests below model
 *      exactly that shape — a *clean committed* B whose ignored export still
 *      carries A's bytes — and prove those bytes cannot reach the artifact.
 *      A dirty tracked tree would only re-prove ESZ-126's drift guard, so
 *      each state used here is asserted clean-committed first.
 *
 * The suite also owns the reconciliation between the runbook's deployed
 * commands and the artifact: the packaged `app/bin/` set is derived from the
 * document, and omitting one of them is a deterministic verification failure.
 *
 * Run: `node --test scripts/production-artifact-runbook.test.mjs`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CANONICAL_REPOSITORY, PROVENANCE_FORMAT } from "./production-provenance.mjs";
import {
  BUILD_PROCEDURE_MARKER,
  PRODUCTION_OPERATOR_COMMANDS,
  RUNBOOK_RELATIVE_PATH,
  parseProcedureCommand,
  productionBuildProcedure,
  readRunbook,
  runbookOperatorCommands,
} from "./production-runbook.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

/** A sentinel that a real Next export can never produce. */
const STALE_MARKER = "ESZ-143-STALE-EXPORT-FROM-SOURCE-STATE-A";
const STALE_FILE = "stale-source-state-a.txt";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    ...options,
  });
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function git(args, cwd = repoRoot) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A disposable detached worktree of this repository.
 *
 * A worktree, not a `git clone` of the local path: provenance is resolved
 * from the configured remotes, which a linked worktree shares with the
 * repository, so the candidate keeps its real canonical identity instead of
 * one manufactured for the test.
 */
function disposableWorktree(label, commitish = "HEAD") {
  const scratch = mkdtempSync(join(tmpdir(), `esz143-${label}-`));
  const path = join(scratch, "candidate");
  git(["worktree", "add", "--detach", path, commitish]);
  return {
    path,
    head: () => git(["rev-parse", "HEAD"], path),
    cleanup() {
      run("git", ["worktree", "remove", "--force", path], { cwd: repoRoot });
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Assert a checkout is a clean committed candidate, not merely a dirty tree. */
function assertCleanCommitted(path) {
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=no"], path),
    "",
    "this state must be a clean committed source identity — a dirty tree would only re-prove ESZ-126",
  );
}

/** Seed an ignored export that a build of the current source cannot produce. */
function seedStaleExport(path) {
  const exportRoot = join(path, "front", "out");
  rmSync(exportRoot, { recursive: true, force: true });
  mkdirSync(join(exportRoot, "_next"), { recursive: true });
  writeFileSync(join(exportRoot, "index.html"), `<!doctype html><html><body>${STALE_MARKER}</body></html>\n`);
  writeFileSync(join(exportRoot, STALE_FILE), `${STALE_MARKER}\n`);
  writeFileSync(join(exportRoot, "_next", STALE_FILE), `${STALE_MARKER}\n`);
}

function readManifest(artifactRoot) {
  return JSON.parse(readFileSync(join(artifactRoot, "ARTIFACT-MANIFEST.json"), "utf8"));
}

/** Execute the runbook's documented build procedure, verbatim, in `path`. */
function executeDocumentedProcedure(path, procedure) {
  const executed = [];
  for (const command of procedure) {
    const argv = parseProcedureCommand(command);
    const result = run(argv[0], argv.slice(1), { cwd: path });
    executed.push({ command, status: result.status, output: result.output });
    assert.equal(
      result.status,
      0,
      `documented command failed in a clean checkout: \`${command}\`\n${result.output}`,
    );
  }
  return executed;
}

// ── Documentation-side reconciliation (no build required) ─────────────────────

describe("the runbook declares one real, machine-readable build procedure (ESZ-143)", () => {
  test("the documented build procedure names only npm scripts that exist", () => {
    const procedure = productionBuildProcedure();
    assert.ok(procedure.length > 0, `${RUNBOOK_RELATIVE_PATH} declares no build command`);

    const rootScripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
    const frontScripts = JSON.parse(readFileSync(join(repoRoot, "front", "package.json"), "utf8")).scripts;

    for (const command of procedure) {
      const argv = parseProcedureCommand(command);
      assert.equal(argv[0], "npm", `only npm commands may be documented as the build procedure: ${command}`);
      if (argv[1] !== "run") continue;
      const prefixIndex = argv.indexOf("--prefix");
      const scripts = prefixIndex === -1 ? rootScripts : { front: frontScripts }[argv[prefixIndex + 1]];
      assert.ok(scripts, `unknown --prefix workspace in a documented command: ${command}`);
      assert.ok(
        Object.hasOwn(scripts, argv[2]),
        `the runbook documents \`${command}\`, but no such npm script exists`,
      );
    }

    // The archive path the runbook promises is the one the packager emits.
    assert.match(readRunbook(), /dist\/eszter-production\.tar\.gz/);
    assert.ok(readRunbook().includes(BUILD_PROCEDURE_MARKER));
  });

  test("the runbook's deployed commands are exactly the packaged operator set", () => {
    assert.deepEqual(runbookOperatorCommands(), [...PRODUCTION_OPERATOR_COMMANDS].sort());
    for (const command of PRODUCTION_OPERATOR_COMMANDS) {
      assert.ok(
        existsSync(join(repoRoot, "php", "bin", command)),
        `the runbook documents bin/${command}, which has no source command`,
      );
    }
    // Repository tooling stays out of the release: an artifact is not a
    // development checkout.
    for (const excluded of [
      "bootstrap-development.php",
      "generate-htaccess.php",
      "lint.php",
      "static-analysis.php",
      "sync-contracts.php",
    ]) {
      assert.ok(existsSync(join(repoRoot, "php", "bin", excluded)));
      assert.ok(
        !PRODUCTION_OPERATOR_COMMANDS.includes(excluded),
        `development tooling must not be packaged: ${excluded}`,
      );
    }
  });

  test("packaging refuses when the documented dependency step has not been run", () => {
    const candidate = disposableWorktree("prereq");
    try {
      assertCleanCommitted(candidate.path);
      assert.equal(existsSync(join(candidate.path, "front", "node_modules")), false);
      const packaging = run("node", [join(candidate.path, "scripts", "build-production-artifact.mjs")], {
        cwd: candidate.path,
      });
      assert.notEqual(packaging.status, 0);
      assert.match(packaging.output, /frontend dependencies \(run: npm ci --prefix front\)/);
      assert.equal(existsSync(join(candidate.path, "dist")), false, "nothing may be emitted before the refusal");
    } finally {
      candidate.cleanup();
    }
  });
});

// ── The procedure, executed from a clean checkout ─────────────────────────────

describe("the documented procedure builds a release from a clean checkout (ESZ-143)", () => {
  let candidate;
  let artifactRoot;
  let archivePath;
  let head;
  const procedure = productionBuildProcedure();

  before(() => {
    candidate = disposableWorktree("clean");
    artifactRoot = join(candidate.path, "dist", "eszter-production");
    archivePath = join(candidate.path, "dist", "eszter-production.tar.gz");
    head = candidate.head();

    // The proof is worthless if a build output travelled in: this checkout owns
    // no trusted export, no installed dependency set and no previous artifact.
    for (const absent of [
      "front/out",
      "front/.next",
      "front/node_modules",
      "contracts/dist",
      "contracts/node_modules",
      "php/vendor",
      "dist",
    ]) {
      assert.equal(
        existsSync(join(candidate.path, absent)),
        false,
        `the clean checkout must not start with ${absent}`,
      );
    }
    assertCleanCommitted(candidate.path);

    executeDocumentedProcedure(candidate.path, procedure);
  });

  after(() => candidate?.cleanup());

  test("the archive exists, verifies, and attests this exact candidate", () => {
    assert.ok(existsSync(archivePath), "the documented procedure must produce dist/eszter-production.tar.gz");

    const manifest = readManifest(artifactRoot);
    assert.deepEqual(manifest.provenance, {
      format: PROVENANCE_FORMAT,
      repository: CANONICAL_REPOSITORY,
      commit: head,
    });
    assert.equal(manifest.nodeRuntimeRequired, false);

    const verify = run("npm", ["run", "artifact:verify"], { cwd: candidate.path });
    assert.equal(verify.status, 0, `artifact:verify rejected the documented build:\n${verify.output}`);
  });

  test("every operator command the runbook documents is packaged and starts", () => {
    const packaged = readdirSync(join(artifactRoot, "app", "bin")).sort();
    assert.deepEqual(packaged, [...PRODUCTION_OPERATOR_COMMANDS].sort());

    for (const command of PRODUCTION_OPERATOR_COMMANDS) {
      const help = run("php", [join(artifactRoot, "app", "bin", command), "--help"]);
      assert.equal(help.status, 0, `packaged bin/${command} --help exited ${help.status}: ${help.output}`);
      assert.match(help.stdout, new RegExp(`Usage: php bin/${command.replace(/\./g, "\\.")}`));
    }
  });

  test("omitting a documented operator command fails verification deterministically", () => {
    const scratch = mkdtempSync(join(tmpdir(), "esz143-omission-"));
    try {
      const copied = join(scratch, "eszter-production");
      cpSync(artifactRoot, copied, { recursive: true });
      rmSync(join(copied, "app", "bin", "maintain-logs.php"));

      const verify = run("node", [
        join(candidate.path, "scripts", "verify-production-artifact.mjs"),
        "--artifact-root", copied,
        "--skip-archive",
        "--expect-repository", CANONICAL_REPOSITORY,
        "--expect-commit", head,
      ]);
      assert.notEqual(verify.status, 0, "a missing operator command must fail verification");
      assert.match(verify.output, /missing required file: app\/bin\/maintain-logs\.php/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a stale ignored export is rebuilt, not shipped", () => {
    // The clean checkout is unchanged source; only the ignored export is
    // replaced by bytes no build of it could ever emit.
    seedStaleExport(candidate.path);
    assertCleanCommitted(candidate.path);
    assert.match(readFileSync(join(candidate.path, "front", "out", "index.html"), "utf8"), /ESZ-143-STALE/);

    const packaging = run("npm", ["run", "artifact:production"], { cwd: candidate.path });
    assert.equal(packaging.status, 0, `packaging over a stale export failed:\n${packaging.output}`);

    const index = readFileSync(join(artifactRoot, "public_html", "index.html"), "utf8");
    assert.ok(!index.includes(STALE_MARKER), "stale export bytes reached the artifact");
    assert.equal(existsSync(join(artifactRoot, "public_html", STALE_FILE)), false);
    assert.equal(existsSync(join(artifactRoot, "public_html", "_next", STALE_FILE)), false);
    assert.equal(existsSync(join(candidate.path, "front", "out", STALE_FILE)), false, "the stale export must be deleted, not merged");

    const manifest = readManifest(artifactRoot);
    assert.equal(manifest.provenance.commit, head);
    for (const name of Object.keys(manifest.files)) {
      assert.ok(!name.includes(STALE_FILE), `stale file survived into the manifest: ${name}`);
    }
  });

  test("an export built at source state A cannot ship inside an artifact attesting clean committed state B", () => {
    const stateB = disposableWorktree("state-b", head);
    try {
      // State B: a different *committed* source identity, reached without ever
      // dirtying the tree that gets packaged. ESZ-126's drift guard therefore
      // has nothing to reject, which is the whole point — this must fail for an
      // ESZ-143 reason or not at all.
      const gitignore = join(stateB.path, ".gitignore");
      writeFileSync(gitignore, `${readFileSync(gitignore, "utf8")}# ESZ-143 source state B\n`);
      const commit = run("git", ["-c", "user.name=ESZ-143", "-c", "user.email=esz-143@example.invalid",
        "commit", "--no-verify", "--quiet", "-am", "ESZ-143 source state B"], { cwd: stateB.path });
      assert.equal(commit.status, 0, `state B commit failed: ${commit.output}`);
      const commitB = stateB.head();
      assert.notEqual(commitB, head, "state B must be a different commit from state A");
      assertCleanCommitted(stateB.path);

      // B installs its own locked dependencies through the documented step,
      // then inherits A's ignored export untouched — the exact unsafe state.
      executeDocumentedProcedure(stateB.path, [procedure[0]]);
      seedStaleExport(stateB.path);

      const packaging = run("npm", ["run", "artifact:production"], { cwd: stateB.path });
      assert.equal(packaging.status, 0, `packaging clean committed state B failed:\n${packaging.output}`);
      assert.doesNotMatch(
        packaging.output,
        /tracked index\/worktree does not match HEAD/,
        "state B must not be rejected as dirty — that would prove ESZ-126, not ESZ-143",
      );

      const artifactB = join(stateB.path, "dist", "eszter-production");
      const manifest = readManifest(artifactB);
      assert.equal(manifest.provenance.commit, commitB, "the artifact must attest state B");
      assert.equal(existsSync(join(artifactB, "public_html", STALE_FILE)), false, "state A's export shipped as state B");
      assert.ok(!readFileSync(join(artifactB, "public_html", "index.html"), "utf8").includes(STALE_MARKER));

      const verify = run("npm", ["run", "artifact:verify"], { cwd: stateB.path });
      assert.equal(verify.status, 0, `state B's artifact failed verification:\n${verify.output}`);
    } finally {
      stateB.cleanup();
    }
  });
});
