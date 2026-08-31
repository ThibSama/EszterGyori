#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");
const artifactRoot = join(distRoot, "eszter-production");
const archivePath = join(distRoot, "eszter-production.tar.gz");
const tarPath = join(distRoot, "eszter-production.tar");

const runtimeBins = [
  "migrate.php",
  "provision-admin.php",
  "provision-booking-service.php",
  "run-notification-jobs.php",
  // ESZ-083. A backup tool that is not in the artifact is a backup tool the
  // operator does not have on the day they need it, and the day they need it is
  // never a day for uploading a script by hand.
  "backup.php",
  "restore.php",
];

function fail(message) {
  process.stderr.write(`package-production: ${message}\n`);
  process.exit(1);
}

function requirePath(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${relative(repoRoot, path)}`);
}

function copy(source, destination) {
  requirePath(source, "required input");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true, preserveTimestamps: false });
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
}

function walk(root, visit, current = root) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`symbolic links are not permitted in the artifact: ${relative(root, path)}`);
    visit(path, stat);
    if (stat.isDirectory()) walk(root, visit, path);
  }
}

function artifactPath(path) {
  return relative(artifactRoot, path).split(sep).join("/");
}

function removeSourceMaps() {
  walk(join(artifactRoot, "public_html"), (path, stat) => {
    if (stat.isFile() && path.endsWith(".map")) unlinkSync(path);
  });
}

function pruneProductionVendor() {
  const vendor = join(artifactRoot, "app", "vendor");
  const removals = [];
  walk(vendor, (path, stat) => {
    const name = path.split(sep).at(-1) ?? "";
    if (stat.isDirectory() && /^(?:tests?|docs?)$/i.test(name)) removals.push(path);
    if (stat.isFile() && /^(?:composer\.json|readme(?:\..*)?|changelog(?:\..*)?)$/i.test(name)) removals.push(path);
  });
  removals.sort((left, right) => right.length - left.length);
  for (const path of removals) rmSync(path, { recursive: true, force: true });
}

function normalizeModes() {
  chmodSync(artifactRoot, 0o755);
  walk(artifactRoot, (path, stat) => {
    const rel = artifactPath(path);
    if (stat.isDirectory()) {
      chmodSync(path, rel === "config" ? 0o700 : rel.startsWith("public_html") ? 0o755 : 0o750);
      return;
    }
    chmodSync(path, rel.startsWith("app/bin/") ? 0o750 : rel.startsWith("public_html/") ? 0o644 : 0o640);
  });
}

function createManifest() {
  const files = {};
  const directories = [];
  walk(artifactRoot, (path, stat) => {
    const rel = artifactPath(path);
    if (stat.isDirectory()) {
      directories.push(rel);
    } else if (rel !== "ARTIFACT-MANIFEST.json") {
      files[rel] = {
        bytes: stat.size,
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    }
  });
  const manifest = {
    format: "eszter-production-artifact/v1",
    publicRoot: "public_html",
    phpMinimum: "8.2",
    nodeRuntimeRequired: false,
    directories: directories.sort(),
    files,
  };
  writeFileSync(join(artifactRoot, "ARTIFACT-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(join(artifactRoot, "ARTIFACT-MANIFEST.json"), 0o640);
}

requirePath(join(repoRoot, "front", "out", "index.html"), "static export (run the frontend build first)");
requirePath(join(repoRoot, "contracts", "generated", "manifest.json"), "generated contracts");
requirePath(join(repoRoot, "php", "composer.lock"), "Composer lock file");

mkdirSync(distRoot, { recursive: true });
rmSync(artifactRoot, { recursive: true, force: true });
rmSync(archivePath, { force: true });
rmSync(tarPath, { force: true });

copy(join(repoRoot, "front", "out"), join(artifactRoot, "public_html"));
copy(join(repoRoot, "php", "public", "api", "index.php"), join(artifactRoot, "public_html", "api", "index.php"));
copy(join(repoRoot, "php", "public", ".htaccess"), join(artifactRoot, "public_html", ".htaccess"));
copy(join(repoRoot, "php", "public", "media", ".htaccess"), join(artifactRoot, "public_html", "media", ".htaccess"));
removeSourceMaps();

copy(join(repoRoot, "php", "src"), join(artifactRoot, "app", "src"));
copy(join(repoRoot, "contracts", "generated"), join(artifactRoot, "app", "contracts"));
copy(join(repoRoot, "php", "migrations"), join(artifactRoot, "app", "migrations"));
for (const file of runtimeBins) {
  copy(join(repoRoot, "php", "bin", file), join(artifactRoot, "app", "bin", file));
}

copy(join(repoRoot, "php", "composer.json"), join(artifactRoot, "app", "composer.json"));
copy(join(repoRoot, "php", "composer.lock"), join(artifactRoot, "app", "composer.lock"));
run("composer", [
  "install",
  "--working-dir", join(artifactRoot, "app"),
  "--no-dev",
  "--no-interaction",
  "--no-progress",
  "--prefer-dist",
  "--classmap-authoritative",
  "--no-scripts",
]);
unlinkSync(join(artifactRoot, "app", "composer.json"));
unlinkSync(join(artifactRoot, "app", "composer.lock"));
pruneProductionVendor();

for (const directory of [
  "config",
  "data/content",
  "data/media-originals/.intake",
  "data/locks",
  "var/log",
  "var/tmp",
  "backups",
]) {
  mkdirSync(join(artifactRoot, directory), { recursive: true });
}

normalizeModes();
createManifest();
run("node", [join(repoRoot, "scripts", "verify-production-artifact.mjs"), "--skip-archive"]);
run("tar", [
  "--sort=name",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "-cf", tarPath,
  "-C", distRoot,
  "eszter-production",
]);
run("gzip", ["-n", "-f", tarPath]);
run("node", [join(repoRoot, "scripts", "verify-production-artifact.mjs")]);

process.stdout.write(`Production artifact: ${relative(repoRoot, artifactRoot)}\nArchive: ${relative(repoRoot, archivePath)}\n`);
