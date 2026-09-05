#!/usr/bin/env node
/**
 * ESZ-126 — negative-proof suite for artifact source provenance.
 *
 * These tests are offline: every fixture is a disposable Git repository under
 * the temporary directory, no remote is ever contacted (a remote URL is only
 * configuration text), and nothing here packages or needs PHP, Composer or a
 * frontend export. They prove the provenance contract at the level it is
 * implemented — remote normalisation, Git-derived identity/HEAD, the clean
 * committed-candidate rule, and fail-closed shape/attestation validation.
 *
 * The end-to-end artifact proofs (tamper detection inside a real archive and
 * byte-determinism of two real packaging runs) live in
 * `scripts/production-artifact-provenance.test.mjs`, which runs against the
 * built `dist/` artifact.
 *
 * Run: `node --test scripts/production-provenance.test.mjs`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import {
  CANONICAL_REPOSITORY,
  COMMIT_SHA_PATTERN,
  PROVENANCE_FORMAT,
  attestationErrors,
  committedCandidateProvenance,
  isCanonicalRepository,
  normalizeRepositoryIdentity,
  provenanceValidationErrors,
} from "./production-provenance.mjs";

const CANONICAL_SSH = "git@github.com:ThibSama/EszterGyori.git";
const CANONICAL_HTTPS = "https://github.com/ThibSama/EszterGyori.git";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return `${result.stdout}`.trim();
}

/** A disposable committed candidate repository. */
function fixtureRepository({ remote = CANONICAL_SSH, files = { "candidate.txt": "committed\n" } } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "esz126-provenance-"));
  try {
    git(["init", "-b", "main"], cwd);
  } catch {
    git(["init"], cwd);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], cwd);
  }
  git(["config", "user.name", "ESZ-126 Test"], cwd);
  git(["config", "user.email", "esz126@example.invalid"], cwd);
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  git(["add", "-A"], cwd);
  git(["commit", "-m", "fixture candidate"], cwd);
  if (remote !== null) git(["remote", "add", "origin", remote], cwd);
  return {
    cwd,
    head: () => git(["rev-parse", "HEAD"], cwd),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function trackingDriftMessage(provenanceCall) {
  assert.throws(provenanceCall, /tracked index\/worktree does not match HEAD/);
}

describe("remote normalisation (ESZ-126)", () => {
  test("SSH and HTTPS origin forms normalise to owner/repo", () => {
    const forms = [
      CANONICAL_SSH,
      "git@github.com:ThibSama/EszterGyori",
      CANONICAL_HTTPS,
      "https://github.com/ThibSama/EszterGyori",
      "https://github.com/ThibSama/EszterGyori/",
      "https://github.com/ThibSama/EszterGyori.git/",
      "ssh://git@github.com/ThibSama/EszterGyori.git",
      "ssh://git@github.com:443/ThibSama/EszterGyori.git",
      "https://github.com/thibsama/esztergyori.git",
      "https://www.github.com/ThibSama/EszterGyori.git",
      "  git@github.com:ThibSama/EszterGyori.git  ",
    ];
    for (const form of forms) {
      const identity = normalizeRepositoryIdentity(form);
      assert.ok(identity, `expected ${form} to resolve`);
      assert.ok(isCanonicalRepository(identity), `${form} resolved to ${identity}`);
    }
    assert.equal(normalizeRepositoryIdentity(CANONICAL_SSH), "ThibSama/EszterGyori");
    assert.equal(normalizeRepositoryIdentity(CANONICAL_HTTPS), "ThibSama/EszterGyori");
  });

  test("unsupported schemes, hosts and shapes do not resolve", () => {
    const rejected = [
      null,
      42,
      "",
      "   ",
      "ThibSama/EszterGyori", // bare owner/repo is not an origin URL
      "git://github.com/ThibSama/EszterGyori.git", // git:// is not supported
      "http://github.com/ThibSama/EszterGyori.git", // plain http is not supported
      "https://gitlab.com/ThibSama/EszterGyori.git",
      "git@gitlab.com:ThibSama/EszterGyori.git",
      "git@example.com:ThibSama/EszterGyori.git",
      "https://github.com/ThibSama/EszterGyori/extra", // extra path segment
      "https://github.com/ThibSama", // no repository
      "https://github.com/", // nothing at all
      "file:///srv/git/EszterGyori.git",
      "git@github.com:ThibSama/EszterGyori.git/extra",
    ];
    for (const form of rejected) {
      assert.equal(normalizeRepositoryIdentity(form), null, `expected ${JSON.stringify(form)} to be rejected`);
    }
  });

  test("the canonical check accepts only the canonical owner/repo, case-insensitively", () => {
    for (const identity of ["ThibSama/EszterGyori", "thibsama/esztergyori", "THIBSAMA/ESZTERGYORI"]) {
      assert.equal(isCanonicalRepository(identity), true, identity);
    }
    for (const identity of [
      "ThibSama/EszterGyori/",
      "/ThibSama/EszterGyori",
      "ThibSama/EszterGyori/extra",
      "ThibSama/EszterGyor",
      "Other/Repo",
      "ThibSama",
      "",
    ]) {
      assert.equal(isCanonicalRepository(identity), false, identity);
    }
  });
});

describe("committed candidate provenance (ESZ-126)", () => {
  test("a clean committed candidate carries the canonical repository and its exact HEAD", () => {
    const fixture = fixtureRepository();
    try {
      const head = fixture.head();
      assert.match(head, COMMIT_SHA_PATTERN);
      const provenance = committedCandidateProvenance(fixture.cwd);
      assert.deepEqual(provenance, {
        format: PROVENANCE_FORMAT,
        repository: CANONICAL_REPOSITORY,
        commit: head,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("the HTTPS origin form resolves identically", () => {
    const fixture = fixtureRepository({ remote: CANONICAL_HTTPS });
    try {
      const provenance = committedCandidateProvenance(fixture.cwd);
      assert.equal(provenance.repository, CANONICAL_REPOSITORY);
      assert.equal(provenance.commit, fixture.head());
    } finally {
      fixture.cleanup();
    }
  });

  test("a repository whose remotes are not the canonical repository is refused", () => {
    const fixture = fixtureRepository({ remote: "git@github.com:Someone/Else.git" });
    try {
      assert.throws(
        () => committedCandidateProvenance(fixture.cwd),
        /repository identity mismatch: expected ThibSama\/EszterGyori/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("a checkout with no remote cannot resolve any identity", () => {
    const fixture = fixtureRepository({ remote: null });
    try {
      assert.throws(
        () => committedCandidateProvenance(fixture.cwd),
        /cannot resolve repository identity: no supported SSH\/HTTPS remote/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("tracked drift and ignored outputs (ESZ-126)", () => {
  test("a staged tracked change refuses provenance", () => {
    const fixture = fixtureRepository();
    try {
      writeFileSync(join(fixture.cwd, "candidate.txt"), "staged drift\n");
      git(["add", "candidate.txt"], fixture.cwd);
      trackingDriftMessage(() => committedCandidateProvenance(fixture.cwd));
    } finally {
      fixture.cleanup();
    }
  });

  test("an unstaged tracked change refuses provenance", () => {
    const fixture = fixtureRepository();
    try {
      writeFileSync(join(fixture.cwd, "candidate.txt"), "unstaged drift\n");
      trackingDriftMessage(() => committedCandidateProvenance(fixture.cwd));
    } finally {
      fixture.cleanup();
    }
  });

  test("ignored build outputs do not alter source identity", () => {
    const fixture = fixtureRepository({
      files: {
        "candidate.txt": "committed\n",
        ".gitignore": "out/\ndist/\nnode_modules/\n",
      },
    });
    try {
      const cleanProvenance = committedCandidateProvenance(fixture.cwd);
      for (const ignored of ["out/index.html", "dist/eszter-production.tar.gz", "node_modules/pkg/index.js"]) {
        mkdirSync(dirname(join(fixture.cwd, ignored)), { recursive: true });
        writeFileSync(join(fixture.cwd, ignored), "ignored build output\n");
      }
      const provenance = committedCandidateProvenance(fixture.cwd);
      assert.deepEqual(provenance, cleanProvenance, "ignored outputs must not change the provenance");
    } finally {
      fixture.cleanup();
    }
  });

  test("untracked non-ignored files are not tracked drift", () => {
    // The ESZ-126 rule refuses staged/unstaged *tracked* changes; an untracked
    // file is not part of the tracked state compared against HEAD.
    const fixture = fixtureRepository();
    try {
      writeFileSync(join(fixture.cwd, "scratch.txt"), "untracked\n");
      const provenance = committedCandidateProvenance(fixture.cwd);
      assert.equal(provenance.commit, fixture.head());
    } finally {
      fixture.cleanup();
    }
  });
});

describe("provenance shape and attestation (ESZ-126)", () => {
  const valid = {
    format: PROVENANCE_FORMAT,
    repository: CANONICAL_REPOSITORY,
    commit: "0123456789abcdef0123456789abcdef01234567",
  };

  test("a well-formed provenance validates with no problems", () => {
    assert.deepEqual(provenanceValidationErrors(valid), []);
  });

  test("absent provenance fails", () => {
    for (const missing of [undefined, null]) {
      const errors = provenanceValidationErrors(missing);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /provenance is absent/);
    }
    assert.equal(provenanceValidationErrors(42).length, 1);
    assert.equal(provenanceValidationErrors("text").length, 1);
  });

  test("a provenance of the wrong or missing format fails", () => {
    const errors = provenanceValidationErrors({ ...valid, format: "eszter-production-artifact/v1" });
    assert.ok(errors.some((error) => /provenance format is not/.test(error)));
    const missingFormat = provenanceValidationErrors({ repository: valid.repository, commit: valid.commit });
    assert.ok(missingFormat.some((error) => /provenance format is not/.test(error)));
  });

  test("a repository mismatch fails", () => {
    const errors = provenanceValidationErrors({ ...valid, repository: "Someone/Else" });
    assert.ok(errors.some((error) => /provenance repository is not ThibSama\/EszterGyori/.test(error)));
    const caseErrors = provenanceValidationErrors({ ...valid, repository: "thibsama/esztergyori" });
    assert.ok(
      caseErrors.some((error) => /provenance repository is not ThibSama\/EszterGyori/.test(error)),
      "the manifest must carry the canonical spelling, not a case variant",
    );
  });

  test("a malformed or wrong commit SHA fails", () => {
    for (const commit of [
      "0123456789abcdef0123456789abcdef0123456", // 39 hex
      "0123456789abcdef0123456789abcdef012345678", // 41 hex
      "0123456789ABCDEF0123456789ABCDEF01234567", // uppercase
      "0123456789abcdef0123456789abcdef0123456g", // non-hex
      "HEAD",
      "main",
      123,
      "",
      null,
    ]) {
      const errors = provenanceValidationErrors({ ...valid, commit });
      assert.ok(errors.some((error) => /provenance commit is not a 40-character lowercase hex SHA/.test(error)), `commit ${JSON.stringify(commit)}`);
    }
  });

  test("attestation passes only on an exact trusted match", () => {
    assert.deepEqual(attestationErrors(valid, CANONICAL_REPOSITORY, valid.commit), []);
    const wrongCommit = { ...valid, commit: "ffffffffffffffffffffffffffffffffffffffff" };
    const commitErrors = attestationErrors(wrongCommit, CANONICAL_REPOSITORY, valid.commit);
    assert.ok(commitErrors.some((error) => /does not match attested commit/.test(error)));
    // A non-canonical repository is refused by shape validation before any
    // attestation comparison can happen.
    const repoErrors = attestationErrors({ ...valid, repository: "Someone/Else" }, CANONICAL_REPOSITORY, valid.commit);
    assert.ok(repoErrors.some((error) => /provenance repository is not ThibSama\/EszterGyori/.test(error)));
    assert.deepEqual(attestationErrors(valid, "thibsama/esztergyori", valid.commit), []);
  });

  test("ill-formed trusted expected values fail closed", () => {
    for (const expected of [undefined, null, 42, "ThibSama", "Someone/Else", "git@github.com:ThibSama/EszterGyori.git"]) {
      const errors = attestationErrors(valid, expected, valid.commit);
      assert.ok(errors.some((error) => /trusted expected repository is not/.test(error)), `expected ${JSON.stringify(expected)}`);
    }
    for (const commit of [undefined, "main", "0123456789abcdef0123456789abcdef0123456", "ABCDEF0123456789abcdef0123456789abcdef01"]) {
      const errors = attestationErrors(valid, CANONICAL_REPOSITORY, commit);
      assert.ok(errors.some((error) => /trusted expected commit is not/.test(error)), `expected commit ${JSON.stringify(commit)}`);
    }
    const absent = attestationErrors(undefined, CANONICAL_REPOSITORY, valid.commit);
    assert.ok(absent.some((error) => /provenance is absent/.test(error)));
  });
});
