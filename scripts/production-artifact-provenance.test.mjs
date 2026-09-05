#!/usr/bin/env node
/**
 * ESZ-126 — end-to-end provenance proofs against a real production artifact.
 *
 * These tests need what `npm run artifact:production` produces in `dist/`
 * (the packaged tree and the deterministic archive) and a Git checkout whose
 * HEAD is the committed candidate, so they skip honestly when the artifact is
 * absent — the same stance the SQL suites take without a database engine.
 * They prove what the offline suite in `production-provenance.test.mjs`
 * cannot: provenance *inside* a real packaged/archived artifact, tamper
 * detection on an extracted copy, drift refusal of the real packager before
 * any emission, and byte-determinism of two real packaging runs.
 *
 * Order matters within this file: the determinism test repackages, so it runs
 * last and everything before it snapshots `dist/` unchanged.
 *
 * Run after a build: `node --test scripts/production-artifact-provenance.test.mjs`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_REPOSITORY,
  PROVENANCE_FORMAT,
  committedCandidateProvenance,
} from "./production-provenance.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const artifactRoot = join(repoRoot, "dist", "eszter-production");
const archivePath = join(repoRoot, "dist", "eszter-production.tar.gz");
const manifestPath = join(artifactRoot, "ARTIFACT-MANIFEST.json");
const builder = join(scriptsDir, "build-production-artifact.mjs");
const verifier = join(scriptsDir, "verify-production-artifact.mjs");

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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(root, found = []) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

function treeDigest(root) {
  const digest = createHash("sha256");
  for (const path of walk(root)) {
    digest.update(`${relative(root, path)}\n`);
    digest.update(sha256File(path));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function readManifest(root) {
  return JSON.parse(readFileSync(join(root, "ARTIFACT-MANIFEST.json"), "utf8"));
}

function archivedManifest(archive = archivePath) {
  const result = run("tar", ["-xOf", archive, "eszter-production/ARTIFACT-MANIFEST.json"]);
  assert.equal(result.status, 0, `tar -xOf failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Byte-identical deterministic archive rebuild of a tree (builder flags). */
function rebuildArchive(directory, archive) {
  const parent = dirname(directory);
  const base = relative(parent, directory);
  const tar = `${archive}.tar`;
  const result = run("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "-cf", tar, "-C", parent, base,
  ]);
  assert.equal(result.status, 0, `deterministic tar failed: ${result.stderr}`);
  const gzip = run("gzip", ["-n", "-f", tar]);
  assert.equal(gzip.status, 0, `deterministic gzip failed: ${gzip.stderr}`);
}

function artifactAvailable() {
  return existsSync(archivePath) && existsSync(manifestPath);
}

/** Extracted-artifact scratch tree under the temporary directory. */
function scratchArtifact() {
  const scratch = mkdtempSync(join(tmpdir(), "esz126-artifact-"));
  const extracted = join(scratch, "eszter-production");
  const result = run("tar", ["-xzf", archivePath, "-C", scratch]);
  assert.equal(result.status, 0, `scratch extraction failed: ${result.stderr}`);
  return { scratch, extracted, archive: join(scratch, "eszter-production.tar.gz"), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

describe("production artifact provenance, end to end (ESZ-126)", { skip: !artifactAvailable() && "dist artifact absent — run npm run artifact:production first" }, () => {
  test("the packaged manifest and the archived manifest carry the canonical repository and this checkout's HEAD", () => {
    const head = git(["rev-parse", "HEAD"]);
    const expected = committedCandidateProvenance(repoRoot);
    assert.equal(expected.commit, head);

    const packaged = readManifest(artifactRoot).provenance;
    assert.deepEqual(packaged, { format: PROVENANCE_FORMAT, repository: CANONICAL_REPOSITORY, commit: head });

    // Provenance of the manifest bytes *inside* the archive, not of the
    // working-directory manifest only.
    const archived = archivedManifest().provenance;
    assert.deepEqual(archived, packaged);

    const verify = run("node", [verifier]);
    assert.equal(verify.status, 0, `verifier rejected a provenance-correct artifact:\n${verify.output}`);
    assert.match(verify.stdout, /verified/);
  });

  test("an extracted artifact verifies under explicit trusted identity — never syntax-only", () => {
    const head = git(["rev-parse", "HEAD"]);
    const scratch = scratchArtifact();
    try {
      const copiedArchive = join(scratch.scratch, "copied.tar.gz");
      const copyResult = run("cp", [archivePath, copiedArchive]);
      assert.equal(copyResult.status, 0, copyResult.stderr);

      // Trusted expected values matching the provenance: the deployment-side
      // verification of an extracted release.
      const good = run("node", [
        verifier,
        "--artifact-root", scratch.extracted,
        "--archive", copiedArchive,
        "--expect-repository", CANONICAL_REPOSITORY,
        "--expect-commit", head,
      ]);
      assert.equal(good.status, 0, `verifier rejected a faithful extracted copy:\n${good.output}`);

      // The same extracted copy under a *different* trusted commit must fail:
      // verification is attestation, never syntax-only shape checking.
      const otherCommit = head.startsWith("0") ? `1${head.slice(1)}` : `0${head.slice(1)}`;
      const wrong = run("node", [
        verifier,
        "--artifact-root", scratch.extracted,
        "--archive", copiedArchive,
        "--expect-repository", CANONICAL_REPOSITORY,
        "--expect-commit", otherCommit,
      ]);
      assert.notEqual(wrong.status, 0);
      assert.match(wrong.output, /provenance commit .* does not match attested commit/);
    } finally {
      scratch.cleanup();
    }
  });

  test("provenance tampering in the extracted artifact and its archive is detected", () => {
    const head = git(["rev-parse", "HEAD"]);
    const scratch = scratchArtifact();
    try {
      // Tamper the extracted manifest provenance (flip the final hex digit of
      // the commit) and rebuild a byte-deterministic archive from the tampered
      // tree, so the archive and the directory agree and only the attestation
      // can catch the forgery.
      const manifest = readManifest(scratch.extracted);
      const forged = manifest.provenance.commit.endsWith("0") ? "1" : "0";
      manifest.provenance.commit = `${manifest.provenance.commit.slice(0, -1)}${forged}`;
      writeFileSync(join(scratch.extracted, "ARTIFACT-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      rebuildArchive(scratch.extracted, scratch.archive);

      const verify = run("node", [
        verifier,
        "--artifact-root", scratch.extracted,
        "--archive", scratch.archive,
        "--expect-repository", CANONICAL_REPOSITORY,
        "--expect-commit", head,
      ]);
      assert.notEqual(verify.status, 0, "tampered provenance must fail verification");
      assert.match(verify.output, /provenance commit .* does not match attested commit/);
    } finally {
      scratch.cleanup();
    }
  });

  test("staged or unstaged tracked drift makes the packager refuse before emitting anything", () => {
    const drift = mkdtempSync(join(tmpdir(), "esz126-drift-"));
    const worktree = join(drift, "drift-checkout");
    try {
      git(["worktree", "add", "--detach", worktree, "HEAD"]);

      // Unstaged tracked drift. The packager refuses on provenance before it
      // even looks for front/out, so the drift checkout needs no build inputs.
      const gitignore = join(worktree, ".gitignore");
      writeFileSync(gitignore, `${readFileSync(gitignore, "utf8")}# ESZ-126 drift\n`);
      let packaging = run("node", [join(worktree, "scripts", "build-production-artifact.mjs")], { cwd: worktree });
      assert.notEqual(packaging.status, 0, "unstaged tracked drift must refuse packaging");
      assert.match(packaging.output, /tracked index\/worktree does not match HEAD/);
      assert.equal(existsSync(join(worktree, "dist")), false, "nothing may be emitted before the refusal");

      // Staged tracked drift, same refusal.
      git(["add", ".gitignore"], worktree);
      packaging = run("node", [join(worktree, "scripts", "build-production-artifact.mjs")], { cwd: worktree });
      assert.notEqual(packaging.status, 0, "staged tracked drift must refuse packaging");
      assert.match(packaging.output, /tracked index\/worktree does not match HEAD/);
      assert.equal(existsSync(join(worktree, "dist")), false, "nothing may be emitted before the refusal");
    } finally {
      const removal = run("git", ["worktree", "remove", "--force", worktree]);
      assert.equal(removal.status, 0, removal.stderr);
      rmSync(drift, { recursive: true, force: true });
    }
  });

  test("two packaging runs from the same committed candidate are byte-identical", () => {
    const head = git(["rev-parse", "HEAD"]);
    const firstTree = treeDigest(artifactRoot);
    const firstArchive = sha256File(archivePath);

    const packaging = run("node", [builder], { cwd: repoRoot });
    assert.equal(packaging.status, 0, `second packaging run failed:\n${packaging.output}`);

    assert.equal(treeDigest(artifactRoot), firstTree, "second packaging run changed artifact bytes");
    assert.equal(sha256File(archivePath), firstArchive, "second packaging run changed archive bytes");
    assert.equal(readManifest(artifactRoot).provenance.commit, head);
  });
});
