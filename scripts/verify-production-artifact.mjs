#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attestationErrors,
  resolveHeadCommit,
  resolveRepositoryIdentity,
} from "./production-provenance.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");

// ESZ-126. The verifier can prove any artifact tree: the packaged tree inside
// this repository by default, or an extracted artifact elsewhere via
// --artifact-root/--archive (used by tamper checks and by deployment-side
// verification of an extracted release).
function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const artifactRoot = flagValue("--artifact-root") ?? join(distRoot, "eszter-production");
const archivePath = flagValue("--archive") ?? join(distRoot, "eszter-production.tar.gz");
const expectRepository = flagValue("--expect-repository");
const expectCommit = flagValue("--expect-commit");
const skipArchive = process.argv.includes("--skip-archive");
const errors = [];

// ── ESZ-126: trusted provenance attestation ────────────────────────────────────
// Inside the source repository the manifest is attested against the current
// Git identity and HEAD. For an extracted artifact outside a repository the
// operator must supply trusted --expect-repository/--expect-commit values;
// the verifier never falls back to syntax-only validation.
let expectedRepository;
let expectedCommit;
if (expectRepository !== undefined || expectCommit !== undefined) {
  if (expectRepository === undefined || expectCommit === undefined) {
    errors.push("--expect-repository and --expect-commit must be supplied together");
  } else {
    expectedRepository = expectRepository;
    expectedCommit = expectCommit;
  }
} else if (existsSync(join(repoRoot, ".git"))) {
  try {
    expectedRepository = resolveRepositoryIdentity(repoRoot);
    expectedCommit = resolveHeadCommit(repoRoot);
  } catch (error) {
    errors.push(`cannot attest provenance against the enclosing repository: ${error.message}`);
  }
} else {
  errors.push(
    "cannot attest provenance: no Git repository encloses this artifact and no " +
      "trusted --expect-repository/--expect-commit values were supplied",
  );
}

function rel(path) {
  return relative(artifactRoot, path).split(sep).join("/");
}

function walk(current = artifactRoot, found = []) {
  if (!existsSync(current)) return found;
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const stat = lstatSync(path);
    found.push({ path, name: rel(path), stat });
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, found);
  }
  return found;
}

function required(path, kind = "file") {
  const absolute = join(artifactRoot, path);
  if (!existsSync(absolute)) errors.push(`missing required ${kind}: ${path}`);
  else if (kind === "file" && !lstatSync(absolute).isFile()) errors.push(`required file is not a file: ${path}`);
  else if (kind === "directory" && !lstatSync(absolute).isDirectory()) errors.push(`required directory is not a directory: ${path}`);
}

for (const file of [
  "ARTIFACT-MANIFEST.json",
  "public_html/index.html",
  "public_html/.htaccess",
  "public_html/api/index.php",
  "public_html/media/.htaccess",
  "app/vendor/autoload.php",
  "app/vendor/symfony/mailer/Transport.php",
  "app/contracts/manifest.json",
  "app/migrations/0001_admin_accounts.sql",
  "app/bin/migrate.php",
  "app/bin/run-notification-jobs.php",
  // ESZ-083. Required, not optional: an operator who cannot take a backup from
  // the release they deployed has no backup, and the moment they discover that is
  // the moment it is too late to fix.
  "app/bin/backup.php",
  "app/bin/restore.php",
]) required(file);

for (const directory of [
  "config",
  "data/content",
  "data/media-originals/.intake",
  "data/locks",
  "var/log",
  "var/tmp",
  "backups",
]) required(directory, "directory");

const entries = walk();
for (const entry of entries) {
  if (entry.stat.isSymbolicLink()) errors.push(`symbolic link is forbidden: ${entry.name}`);
}

const forbiddenSegments = /(^|\/)(node_modules|\.next|tests?|docs?|\.git|cache)(\/|$)/i;
const forbiddenFiles = /(^|\/)(package(?:-lock)?\.json|composer\.(?:json|lock)|\.env(?:\..*)?|config\.php|phpunit\.xml(?:\.dist)?)(\/|$)/i;
const sourceOnlyExtensions = /\.(?:ts|tsx|map)$/i;
for (const { name, stat } of entries) {
  if (forbiddenSegments.test(name)) errors.push(`unwanted directory or segment: ${name}`);
  if (stat.isFile() && forbiddenFiles.test(name)) errors.push(`unwanted runtime file: ${name}`);
  if (stat.isFile() && sourceOnlyExtensions.test(name)) errors.push(`source-only file: ${name}`);
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:smtp|mysql):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[=:]\s*["'][A-Za-z0-9+/_=-]{16,}["']/i,
];
for (const { path, name, stat } of entries) {
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) errors.push(`secret-like material detected: ${name}`);
}

const publicPhp = entries.filter(({ name, stat }) => stat.isFile() && name.startsWith("public_html/") && name.endsWith(".php"));
if (publicPhp.map(({ name }) => name).join(",") !== "public_html/api/index.php") {
  errors.push(`public PHP surface must be exactly public_html/api/index.php; found ${publicPhp.map(({ name }) => name).join(", ") || "none"}`);
}
for (const privateRoot of ["app", "config", "data", "var", "backups"]) {
  if (existsSync(join(artifactRoot, "public_html", privateRoot))) errors.push(`private tree appears under public root: ${privateRoot}`);
}

if (existsSync(join(artifactRoot, "config")) && readdirSync(join(artifactRoot, "config")).length !== 0) {
  errors.push("config/ must be empty; deployment secrets are created by the operator after extraction");
}

const manifestPath = join(artifactRoot, "ARTIFACT-MANIFEST.json");
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.format !== "eszter-production-artifact/v1") errors.push("unexpected manifest format");
    if (manifest.publicRoot !== "public_html") errors.push("manifest publicRoot is not public_html");
    if (manifest.nodeRuntimeRequired !== false) errors.push("manifest must declare nodeRuntimeRequired=false");
    if (expectedRepository !== undefined && expectedCommit !== undefined) {
      for (const problem of attestationErrors(
        manifest.provenance,
        expectedRepository,
        expectedCommit,
      )) {
        errors.push(`provenance: ${problem}`);
      }
    }
    const actualFiles = entries
      .filter(({ stat, name }) => stat.isFile() && name !== "ARTIFACT-MANIFEST.json")
      .map(({ name }) => name)
      .sort();
    const declaredFiles = Object.keys(manifest.files ?? {}).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) errors.push("manifest file list differs from artifact");
    for (const name of declaredFiles) {
      const path = join(artifactRoot, name);
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      const declared = manifest.files[name];
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
      if (declared.sha256 !== hash) errors.push(`manifest digest mismatch: ${name}`);
      if (declared.bytes !== stat.size) errors.push(`manifest size mismatch: ${name}`);
      if (declared.mode !== mode) errors.push(`manifest mode mismatch: ${name}`);
    }
  } catch (error) {
    errors.push(`manifest cannot be parsed: ${error.message}`);
  }
}

const installedPath = join(artifactRoot, "app", "vendor", "composer", "installed.json");
if (existsSync(installedPath)) {
  const installed = readFileSync(installedPath, "utf8");
  for (const devPackage of ["phpunit/phpunit", "phpstan/phpstan", "squizlabs/php_codesniffer"]) {
    if (installed.includes(`\"name\": \"${devPackage}\"`)) errors.push(`development Composer package present: ${devPackage}`);
  }
  if (!installed.includes('"name": "symfony/mailer"')) errors.push("Symfony Mailer is absent from production dependencies");
}

for (const [entryPoint, expected] of [
  ["app/bin/migrate.php", "Usage: php bin/migrate.php"],
  ["app/bin/run-notification-jobs.php", "Usage: php bin/run-notification-jobs.php"],
  ["app/bin/backup.php", "Usage: php bin/backup.php"],
  ["app/bin/restore.php", "Usage: php bin/restore.php"],
]) {
  const result = spawnSync("php", [join(artifactRoot, entryPoint), "--help"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.includes(expected)) {
    errors.push(`packaged PHP entry point failed its no-network help smoke: ${entryPoint}`);
  }
}

if (!skipArchive) {
  if (!existsSync(archivePath)) {
    errors.push(`missing deterministic archive: ${relative(repoRoot, archivePath)}`);
  } else {
    // ESZ-126: attest the provenance of the manifest bytes packaged *inside*
    // the archive, not only of the working-directory manifest. A tampered
    // archived manifest fails here even before the determinism rebuild.
    const archiveMember = `${basename(artifactRoot)}/ARTIFACT-MANIFEST.json`;
    const archiveRead = spawnSync("tar", ["-xOf", archivePath, archiveMember], { encoding: "utf8" });
    if (archiveRead.status !== 0) {
      errors.push(`archive does not contain a readable manifest member ${archiveMember}`);
    } else {
      try {
        const archivedManifest = JSON.parse(archiveRead.stdout);
        if (expectedRepository !== undefined && expectedCommit !== undefined) {
          for (const problem of attestationErrors(
            archivedManifest.provenance,
            expectedRepository,
            expectedCommit,
          )) {
            errors.push(`archive provenance: ${problem}`);
          }
        }
      } catch (error) {
        errors.push(`archive manifest cannot be parsed: ${error.message}`);
      }
    }
    const temporary = mkdtempSync(join(tmpdir(), "eszter-artifact-"));
    const secondTar = join(temporary, "comparison.tar");
    const secondArchive = `${secondTar}.gz`;
    const result = spawnSync("tar", [
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "-cf", secondTar, "-C", dirname(artifactRoot), basename(artifactRoot),
    ], { encoding: "utf8" });
    if (result.status !== 0) errors.push(`determinism check could not build comparison archive: ${result.stderr.trim()}`);
    else {
      const gzip = spawnSync("gzip", ["-n", "-f", secondTar], { encoding: "utf8" });
      if (gzip.status !== 0) errors.push(`determinism check could not compress comparison archive: ${gzip.stderr.trim()}`);
      else {
        const first = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
        const second = createHash("sha256").update(readFileSync(secondArchive)).digest("hex");
        if (first !== second) errors.push("archive is not byte-deterministic for identical inputs");
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (errors.length > 0) {
  process.stderr.write(`Production artifact verification failed (${errors.length}):\n${errors.map((error) => `  - ${error}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Production artifact verified: ${entries.filter(({ stat }) => stat.isFile()).length} files; public root isolated; production Composer set; no Node runtime.\n`);
