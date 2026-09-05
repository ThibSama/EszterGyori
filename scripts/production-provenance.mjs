#!/usr/bin/env node
/**
 * ESZ-126 — provenance of a production artifact.
 *
 * The artifact manifest used to attest the shape of every packaged file but
 * not the source it was packaged from. This module is the single provenance
 * implementation shared by the packager (which must refuse anything but a
 * clean, committed candidate of the canonical repository) and the verifier
 * (which attests the manifest provenance against the current Git identity
 * and HEAD, or against trusted --expect-* values for an extracted artifact
 * outside a repository).
 *
 * Rules, all fail-closed:
 *
 *   - provenance is derived from Git only. The commit SHA is `HEAD` of the
 *     candidate checkout, never a branch name and never a caller-supplied
 *     value, and the repository identity is resolved from configured remote
 *     URLs, never stored clone text.
 *   - supported origin forms are SSH and HTTPS (plus the URL form of SSH).
 *     Each is normalised mechanically to `owner/repo`; anything else —
 *     another host, a `git://` or `http://` URL, a path with extra segments
 *     or no owner/repo — does not resolve.
 *   - the resolved identity must match the canonical repository
 *     (`ThibSama/EszterGyori`, GitHub owner/repo names are
 *     case-insensitive). The manifest always carries the canonical spelling,
 *     not the spelling found in a remote URL.
 *   - a tracked index/worktree that differs from HEAD (staged or unstaged)
 *     refuses packaging: modified source must never claim the commit it no
 *     longer matches. Untracked files do not participate in the comparison,
 *     so ignored dependencies and build outputs may exist; they are inputs,
 *     not source identity.
 *   - no branch, timestamp, runner path or hostname ever enters the
 *     provenance, so identical committed inputs stay byte-deterministic.
 */

import { spawnSync } from "node:child_process";

export const CANONICAL_REPOSITORY = "ThibSama/EszterGyori";
export const PROVENANCE_FORMAT = "eszter-production-provenance/v1";
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  }
  return result;
}

/**
 * Normalise one supported origin remote URL (SSH or HTTPS) to `owner/repo`.
 * Returns null for anything unsupported or malformed; the caller decides
 * whether the resulting identity is the canonical repository.
 */
export function normalizeRepositoryIdentity(raw) {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url) return null;

  let host;
  let path;

  // scp-like SSH form: git@github.com:ThibSama/EszterGyori.git. Only for
  // scheme-less strings; anything containing "://" goes through the URL parser.
  if (!url.includes("://")) {
    const match = url.match(/^[^/@\s]+@([^:\s]+):(\S+)$/);
    if (match) {
      host = match[1];
      path = match[2];
    }
  }
  if (!host) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
    host = parsed.hostname;
    path = parsed.pathname;
  }

  if (host !== "github.com" && host !== "www.github.com") return null;
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  path = path.replace(/\.git$/i, "");
  const segments = path.split("/");
  if (segments.length !== 2 || !OWNER_REPO_PATTERN.test(path)) return null;
  return path;
}

/** Case-insensitive equality of two `owner/repo` identities (GitHub names). */
export function isCanonicalRepository(identity) {
  if (typeof identity !== "string") return false;
  const [canonicalOwner, canonicalRepo] = CANONICAL_REPOSITORY.toLowerCase().split("/", 2);
  const segments = identity.toLowerCase().split("/");
  return segments.length === 2 && segments[0] === canonicalOwner && segments[1] === canonicalRepo;
}

/** Normalised identities of every configured remote of the checkout. */
export function configuredRepositoryIdentities(cwd) {
  const remotes = runGit(["remote"], cwd);
  if (remotes.status !== 0) return [];
  const identities = [];
  for (const name of `${remotes.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const url = runGit(["remote", "get-url", name], cwd);
    if (url.status !== 0) continue;
    const identity = normalizeRepositoryIdentity(`${url.stdout}`.trim().split("\n")[0]);
    if (identity) identities.push(identity);
  }
  return [...new Set(identities.map((identity) => identity.toLowerCase()))];
}

/** The canonical repository, resolved from the checkout's remotes. */
export function resolveRepositoryIdentity(cwd) {
  const identities = configuredRepositoryIdentities(cwd);
  if (identities.length === 0) {
    throw new Error(
      `cannot resolve repository identity: no supported SSH/HTTPS remote is configured in ${cwd}`,
    );
  }
  if (identities.some(isCanonicalRepository)) return CANONICAL_REPOSITORY;
  throw new Error(
    `repository identity mismatch: expected ${CANONICAL_REPOSITORY}, remotes resolve to ${identities.join(", ")}`,
  );
}

/** Full lowercase 40-hex commit SHA of HEAD; derived from Git, never a name. */
export function resolveHeadCommit(cwd) {
  const result = runGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  if (result.status !== 0) {
    throw new Error(`HEAD does not resolve to a commit in ${cwd}`);
  }
  const commit = `${result.stdout}`.trim();
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new Error(`HEAD is not a 40-character lowercase hex SHA: ${commit}`);
  }
  return commit;
}

/**
 * Tracked index/worktree drift against HEAD: porcelain lines whose path is a
 * tracked file — staged (`M `, `A `, `R `, …), unstaged (` M`, ` D`, …) or
 * both (`MM`). Untracked (`??`) and ignored files never appear and are not
 * drift: the comparison is about modified source claiming a commit.
 */
export function trackedDrift(cwd) {
  const result = runGit(["status", "--porcelain", "--untracked-files=no"], cwd);
  if (result.status !== 0) {
    throw new Error(`cannot read the tracked state of ${cwd}`);
  }
  return `${result.stdout}`.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}

/**
 * Provenance of a clean committed candidate. Throws when the checkout is not
 * the canonical repository, when HEAD does not resolve, or when staged or
 * unstaged tracked drift exists.
 */
export function committedCandidateProvenance(cwd) {
  const repository = resolveRepositoryIdentity(cwd);
  const commit = resolveHeadCommit(cwd);
  const drift = trackedDrift(cwd);
  if (drift.length > 0) {
    throw new Error(
      `refusing to package: tracked index/worktree does not match HEAD (${drift.length} ` +
        `change${drift.length === 1 ? "" : "s"}) — modified source cannot claim commit ${commit}. ` +
        `First: ${drift[0]}`,
    );
  }
  return { format: PROVENANCE_FORMAT, repository, commit };
}

/**
 * Fail-closed shape validation of a manifest provenance object. Returns the
 * list of problems; an empty list means the provenance is present, of the
 * supported format, the canonical repository, and a well-formed commit SHA.
 */
export function provenanceValidationErrors(provenance) {
  if (provenance === undefined || provenance === null) {
    return ["provenance is absent from the manifest"];
  }
  if (typeof provenance !== "object" || Array.isArray(provenance)) {
    return ["provenance is malformed: not an object"];
  }
  const errors = [];
  if (provenance.format !== PROVENANCE_FORMAT) {
    errors.push(
      `provenance format is not ${PROVENANCE_FORMAT}: ${JSON.stringify(provenance.format)}`,
    );
  }
  if (provenance.repository !== CANONICAL_REPOSITORY) {
    errors.push(
      `provenance repository is not ${CANONICAL_REPOSITORY}: ${JSON.stringify(provenance.repository)}`,
    );
  }
  if (typeof provenance.commit !== "string" || !COMMIT_SHA_PATTERN.test(provenance.commit)) {
    errors.push(
      `provenance commit is not a 40-character lowercase hex SHA: ${JSON.stringify(provenance.commit)}`,
    );
  }
  return errors;
}

/**
 * Attest a manifest provenance against trusted expected repository/commit
 * values (either derived from the enclosing Git checkout or supplied
 * explicitly with --expect-*). Fail-closed: any problem is returned as an
 * error, and an ill-formed expected value is itself an error. A repository
 * that is not the canonical one never reaches the comparison — shape
 * validation refuses it — so the attestation is about the commit above all.
 */
export function attestationErrors(provenance, expectedRepository, expectedCommit) {
  const errors = provenanceValidationErrors(provenance);
  if (typeof expectedRepository !== "string" || !isCanonicalRepository(expectedRepository)) {
    errors.push(
      `trusted expected repository is not ${CANONICAL_REPOSITORY}: ${JSON.stringify(expectedRepository)}`,
    );
  }
  if (typeof expectedCommit !== "string" || !COMMIT_SHA_PATTERN.test(expectedCommit)) {
    errors.push(
      `trusted expected commit is not a 40-character lowercase hex SHA: ${JSON.stringify(expectedCommit)}`,
    );
  }
  if (errors.length > 0) return errors;
  if (provenance.commit !== expectedCommit) {
    errors.push(
      `provenance commit ${provenance.commit} does not match attested commit ${expectedCommit}`,
    );
  }
  return errors;
}
