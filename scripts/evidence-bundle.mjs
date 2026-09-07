#!/usr/bin/env node
/**
 * ESZ-116 — durable candidate evidence.
 *
 * The GitHub `quality-gate` job proves repo-owned quality on an exact
 * `GITHUB_SHA`, but it preserved only logs and a step summary: both are
 * ephemeral, neither is machine-checkable, and neither is bound to the
 * artifact that was actually built. This module turns one canonical
 * validation execution plus the existing artifact outputs into a versioned
 * evidence bundle that outlives the run, and into a verifier that can refuse
 * it.
 *
 * It creates no gate and no second policy. `scripts/validate.mjs` remains the
 * single fail-closed gate policy; this reads the durable report that policy
 * writes (ESZ-116 report capture) and never re-decides what a gate outcome
 * means. Source identity is the ESZ-126 provenance implementation, reused as
 * is: the canonical repository and a Git-derived 40-hex commit.
 *
 * What the bundle binds together, all against one candidate commit:
 *
 *   - the canonical validation report and summary, with every gate result;
 *   - LOCAL quality state, kept structurally separate from deployment/release
 *     state. Nothing here derives "release ready" from local success, and the
 *     verifier refuses a bundle that claims it;
 *   - the production manifest provenance and the SHA-256 of the packaged
 *     `dist/eszter-production.tar.gz`;
 *   - the CI workflow/job/run id, attempt, run URL and head SHA when the
 *     generator runs inside GitHub Actions;
 *   - explicit evidence for the gates whose absence would otherwise be
 *     invisible: the SQL suites, `php:smoke:full-stack`, `smoke:apache`, the
 *     browser scenarios and `deployment:artifact`;
 *   - all eight applicable baseline families, each mapped to the gate ids
 *     that support it;
 *   - both deployment-owned gates, still NOT RUN.
 *
 * Fail-closed verification. Missing or non-PASS required evidence, a
 * repository/commit mismatch, an artifact-provenance mismatch, a referenced
 * file whose bytes changed, a gate id nothing declares, a missing baseline
 * family or a sensitive field anywhere in the index all make `verify` exit
 * non-zero.
 *
 * Nothing that could carry a credential, a cookie, a CSRF token, a customer
 * or admin address, acceptance debt or production data is copied into the
 * bundle: the durable report already drops child stdout/stderr, and the
 * verifier scans the index for sensitive shapes as an independent backstop.
 *
 * Usage:
 *   node scripts/evidence-bundle.mjs generate --report <path> --out <dir>
 *   node scripts/evidence-bundle.mjs verify --bundle <dir> [--expect-commit <sha>]
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_REPOSITORY,
  COMMIT_SHA_PATTERN,
  attestationErrors,
  isCanonicalRepository,
  resolveHeadCommit,
  resolveRepositoryIdentity,
} from "./production-provenance.mjs";
import { DEFERRED_LIVE_GATES, VALIDATION_REPORT_FORMAT } from "./validate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const EVIDENCE_BUNDLE_FORMAT = "eszter-candidate-evidence/v1";
export const ARTIFACT_MANIFEST_FORMAT = "eszter-production-artifact/v1";

const PASS = "PASS";
const NOT_RUN = "NOT RUN";

/** Bundle-relative names. The layout is part of the format. */
export const BUNDLE_FILES = {
  index: "index.json",
  markdown: "index.md",
  validationReport: "validation-report.json",
  artifactManifest: "artifact-manifest.json",
  tarball: "eszter-production.tar.gz",
  bundleDigest: "bundle.sha256",
};

/**
 * Gates whose evidence must be named explicitly.
 *
 * These are the expensive, infrastructure-bearing proofs — real MySQL, the
 * composed product, the packaged artifact under real Apache, real Chrome, and
 * the packaging step itself. A bundle that silently lost one of them would
 * still look green, so the index states each one and the verifier requires it
 * to be present and PASS.
 */
export const EXPLICIT_EVIDENCE_GATES = Object.freeze([
  "sql:migrations",
  "sql:integration",
  "sql:rate-limits",
  "sql:backup-restore",
  "sql:notifications",
  "php:smoke:full-stack",
  "smoke:apache",
  "browser:admin-preview-csp",
  "browser:media-pipeline",
  "browser:admin-booking-contact",
  "browser:public",
  "browser:admin-auth",
  "browser:admin",
  "browser:booking",
  "deployment:artifact",
]);

/**
 * The eight applicable baseline families, each mapped to the canonical gate
 * ids that actually support it.
 *
 * This is a mapping, not a new policy: every id here must exist in the
 * canonical validation report, and the verifier refuses an unknown one. The
 * families and their domain prefixes mirror `docs/project-baseline-matrix.json`
 * (checked by `npm run baseline:verify`); this table says which executed gate
 * is the evidence for each family on this candidate.
 */
export const BASELINE_FAMILIES = Object.freeze([
  {
    family: "Security",
    domainPrefix: "SEC",
    gateIds: [
      "security:dependencies",
      "security:filesystem",
      "php:security",
      "php:http-contract",
      "sql:rate-limits",
      "smoke:apache",
      "browser:admin-preview-csp",
      "browser:admin-auth",
    ],
    evidence:
      "Advisory audit of the locked production dependency sets, filesystem/document-root topology refusal, the frozen rate-limit and authentication policy over real MySQL, the committed security headers and sensitive-name rules proved through real Apache, and CSP/admin authentication proved in a real browser.",
  },
  {
    family: "Architecture",
    domainPrefix: "ARCH",
    gateIds: [
      "contracts:typecheck",
      "contracts:typecheck:tools",
      "contracts:verify:generated",
      "contracts:build",
      "php:http-contract",
      "php:routing",
      "deployment:artifact",
    ],
    evidence:
      "The frozen contract surface type-checks, the committed generated artifacts are byte-identical to a fresh regeneration, the single PHP backend replays that same generated artifact green, routing resolves as declared, and the packaged artifact keeps the public/private split of the target topology.",
  },
  {
    family: "Quality",
    domainPrefix: "QUAL",
    gateIds: [
      "front:lint",
      "php:lint",
      "php:static-analysis",
      "php:composer-validate",
      "contracts:typecheck",
      "contracts:typecheck:tools",
    ],
    evidence:
      "Frontend ESLint including the Next.js rule set, PHP lint and static analysis, Composer manifest validation, and type-checking of both the contract sources and the generator/test tooling.",
  },
  {
    family: "Testing",
    domainPrefix: "TEST",
    gateIds: [
      "contracts:test",
      "front:test",
      "php:unit",
      "php:parity-corpus",
      "sql:integration",
      "browser:public",
      "browser:admin",
      "browser:booking",
      "browser:admin-booking-contact",
      "browser:media-pipeline",
    ],
    evidence:
      "Contract semantics with a rejecting case per declared rule, frontend behaviour, PHP unit and parity-corpus suites, integration over real MySQL, and end-to-end scenarios driven through a real browser against the production-shaped stack.",
  },
  {
    family: "Delivery",
    domainPrefix: "DEL",
    gateIds: [
      "contracts:lockfile",
      "front:lockfile",
      "php:dependencies",
      "contracts:build",
      "front:build",
      "front:export",
      "deployment:artifact",
    ],
    evidence:
      "Reproducible locked installs for every dependency set, the static export produced from those locks, and a deterministic production archive whose manifest carries Git-derived provenance for this exact candidate commit.",
  },
  {
    family: "Operations",
    domainPrefix: "OPS",
    gateIds: [
      "php:backup",
      "php:notifications",
      "sql:migrations",
      "sql:backup-restore",
      "sql:notifications",
      "smoke:local-php",
      "php:smoke:full-stack",
      "smoke:apache",
    ],
    evidence:
      "Backup and restore tooling shipped in the artifact and proved against a real database, the durable notification queue and its dispatcher, forward migrations, and the packaged product served the way the runbook deploys it.",
  },
  {
    family: "Data",
    domainPrefix: "DATA",
    gateIds: [
      "sql:migrations",
      "sql:integration",
      "sql:backup-restore",
      "sql:notifications",
      "php:booking",
      "php:media",
      "php:public-page",
    ],
    evidence:
      "Schema constraints, idempotent migrations and referential rules proved on real MySQL; booking, consent, managed-media catalogue and editorial content behaviour proved against their authoritative stores; backup/restore round-trips the data.",
  },
  {
    family: "Performance",
    domainPrefix: "PERF",
    gateIds: ["front:budgets", "sql:rate-limits", "smoke:apache", "browser:public"],
    evidence:
      "Frontend budgets enforced at build time, bounded index-range reads and rate-limit ceilings proved on real MySQL, immutable caching of hashed static assets through real Apache, and public page load in a real browser.",
  },
]);

/**
 * Sensitive shapes that must never appear in a published evidence index.
 *
 * The durable validation report already drops arbitrary child stdout/stderr,
 * so this is a backstop rather than the primary control: it runs over the
 * fully serialised index, so it also covers anything a future field might
 * carry in.
 */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|credential|cookie|csrf|authorization|auth[-_]?header|api[-_]?key|private[-_]?key|dsn|smtp|session[-_]?id|acceptance[-_]?debt)/i;

const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an e-mail address"],
  [/\b(?:mysql|mariadb|mysqli|pdo)\s*:\s*\/\//i, "a database DSN"],
  [/set-cookie/i, "a cookie header"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i, "a bearer credential"],
  [/\bcsrf\b/i, "a CSRF token reference"],
  [/\bpassword\b/i, "a password reference"],
  [/\bacceptance debt\b/i, "acceptance debt"],
]);

/**
 * Walk a JSON value and report every sensitive key name or value shape found,
 * with the JSON path that reached it. An empty list means the value is clean.
 */
export function sensitiveFieldProblems(value, path = "$") {
  const problems = [];
  if (typeof value === "string") {
    for (const [pattern, label] of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) problems.push(`${path} looks like ${label}`);
    }
    return problems;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...sensitiveFieldProblems(item, `${path}[${index}]`)));
    return problems;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) problems.push(`${path}.${key} is a sensitive field name`);
      problems.push(...sensitiveFieldProblems(child, `${path}.${key}`));
    }
  }
  return problems;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${error?.message ?? error}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${error?.message ?? error}`);
  }
}

/** Atomic write, so a reader never observes a half-written bundle file. */
function writeAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * CI context, when the generator runs inside GitHub Actions.
 *
 * Absent outside Actions — a local bundle is honestly marked `present: false`
 * rather than carrying invented run metadata.
 */
export function githubActionsContext(env = process.env) {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return { present: false };
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  return {
    present: true,
    workflow: env.GITHUB_WORKFLOW ?? null,
    job: env.GITHUB_JOB ?? null,
    runId: env.GITHUB_RUN_ID,
    runNumber: env.GITHUB_RUN_NUMBER ?? null,
    runAttempt: attempt,
    runUrl: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${attempt}`,
    headSha: env.GITHUB_SHA ?? null,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    runnerOs: env.RUNNER_OS ?? null,
  };
}

/**
 * Fail-closed shape check of the durable validation report before anything is
 * derived from it.
 */
export function validationReportProblems(report) {
  const problems = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["validation report is not an object"];
  }
  if (report.format !== VALIDATION_REPORT_FORMAT) {
    problems.push(`validation report format is not ${VALIDATION_REPORT_FORMAT}: ${JSON.stringify(report.format)}`);
  }
  const candidate = report.candidate;
  if (!candidate || typeof candidate !== "object") {
    problems.push("validation report carries no candidate identity");
  } else {
    if (!isCanonicalRepository(candidate.repository)) {
      problems.push(
        `validation report repository is not ${CANONICAL_REPOSITORY}: ${JSON.stringify(candidate.repository)}`,
      );
    }
    if (typeof candidate.commit !== "string" || !COMMIT_SHA_PATTERN.test(candidate.commit)) {
      problems.push(
        `validation report commit is not a 40-character lowercase hex SHA: ${JSON.stringify(candidate.commit)}`,
      );
    }
  }
  if (!Array.isArray(report.gates) || report.gates.length === 0) {
    problems.push("validation report carries no gate results");
  }
  if (!report.local || typeof report.local !== "object") {
    problems.push("validation report carries no local quality summary");
  }
  if (!report.deployment || typeof report.deployment !== "object") {
    problems.push("validation report carries no deployment/deferred summary");
  }
  return problems;
}

/**
 * Build the evidence index from one canonical validation report plus the
 * existing artifact outputs.
 *
 * Throws on anything that would produce a bundle nobody should trust: a
 * report of an unknown shape, an artifact manifest whose provenance does not
 * attest this candidate, a baseline mapping that names a gate the report does
 * not contain, or an explicit-evidence gate that is absent.
 */
export function buildEvidenceIndex({ validationReport, artifactManifest, tarball, ci, generatedAt = null }) {
  const problems = validationReportProblems(validationReport);
  if (problems.length > 0) {
    throw new Error(`unusable validation report:\n  - ${problems.join("\n  - ")}`);
  }

  const candidate = {
    repository: CANONICAL_REPOSITORY,
    commit: validationReport.candidate.commit,
  };

  // ESZ-126 provenance, attested against the same candidate the validation
  // report bound itself to. An artifact packaged from another commit can
  // never be presented as this candidate's artifact.
  const provenanceErrors = attestationErrors(artifactManifest?.provenance, candidate.repository, candidate.commit);
  if (provenanceErrors.length > 0) {
    throw new Error(`artifact provenance does not attest this candidate:\n  - ${provenanceErrors.join("\n  - ")}`);
  }
  if (artifactManifest.format !== ARTIFACT_MANIFEST_FORMAT) {
    throw new Error(
      `artifact manifest format is not ${ARTIFACT_MANIFEST_FORMAT}: ${JSON.stringify(artifactManifest.format)}`,
    );
  }

  const gates = validationReport.gates.map((gate) => ({
    id: gate.id,
    stage: gate.stage,
    status: gate.status,
    required: gate.required,
    deferred: gate.deferred,
    ownership: gate.ownership,
    ...(typeof gate.durationMs === "number" ? { durationMs: gate.durationMs } : {}),
    ...(gate.detail ? { detail: gate.detail } : {}),
    ...(gate.reason ? { reason: gate.reason } : {}),
  }));
  const byId = new Map(gates.map((gate) => [gate.id, gate]));

  for (const id of EXPLICIT_EVIDENCE_GATES) {
    if (!byId.has(id)) throw new Error(`explicit evidence gate ${id} is absent from the validation report`);
  }

  const baselines = BASELINE_FAMILIES.map((family) => {
    const unknown = family.gateIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new Error(`baseline ${family.family} maps unknown gate id(s): ${unknown.join(", ")}`);
    }
    return {
      family: family.family,
      domainPrefix: family.domainPrefix,
      gateIds: [...family.gateIds],
      evidence: family.evidence,
      supportingGates: family.gateIds.map((id) => ({ id, status: byId.get(id).status })),
    };
  });

  const deferredGates = gates
    .filter((gate) => gate.deferred === true)
    .map((gate) => ({
      id: gate.id,
      status: gate.status,
      ownership: gate.ownership,
      reason: gate.reason ?? null,
    }));

  return {
    format: EVIDENCE_BUNDLE_FORMAT,
    candidate,
    ...(generatedAt ? { generatedAt } : {}),

    // Local, repo-owned quality. Structurally separate from `deployment`
    // below, and never a release claim on its own.
    localQuality: {
      scope: "repo-owned local quality only",
      canonicalCommand: "npm run validate",
      policy: "docs/v1-quality-gates.md",
      success: validationReport.local?.success === true,
      counts: validationReport.counts ?? null,
      blocked: Array.isArray(validationReport.blocked) ? [...validationReport.blocked] : [],
    },

    // Deployment/release state. Deliberately not derived from the local
    // result: no local run can establish either field, so both are constants
    // here and the verifier refuses any bundle that flips them.
    deployment: {
      releaseReady: false,
      deployedHostEvidence: "pending",
      statement:
        "This bundle attests repo-owned local quality on the named candidate commit only. Deployed-host evidence does not exist yet, so this is not a release or deployment PASS.",
      deferredCount: deferredGates.length,
      deferredGates,
    },

    gates,

    explicitEvidence: EXPLICIT_EVIDENCE_GATES.map((id) => {
      const gate = byId.get(id);
      return { id, stage: gate.stage, status: gate.status, required: gate.required };
    }),

    baselines,

    artifact: {
      manifestFormat: artifactManifest.format,
      publicRoot: artifactManifest.publicRoot ?? null,
      provenance: { ...artifactManifest.provenance },
      fileCount: Object.keys(artifactManifest.files ?? {}).length,
      tarball,
    },

    ci,

    files: [],
  };
}

/** Human-readable companion. Same facts, no new claims. */
export function renderIndexMarkdown(index) {
  const lines = [];
  lines.push("# Eszter candidate evidence");
  lines.push("");
  lines.push(`- Format: \`${index.format}\``);
  lines.push(`- Repository: \`${index.candidate.repository}\``);
  lines.push(`- Candidate commit: \`${index.candidate.commit}\``);
  if (index.ci?.present) {
    lines.push(`- CI run: [${index.ci.workflow} #${index.ci.runNumber ?? index.ci.runId}](${index.ci.runUrl})`);
    lines.push(`- CI job: \`${index.ci.job}\` — run \`${index.ci.runId}\`, attempt \`${index.ci.runAttempt}\``);
    lines.push(`- CI head SHA: \`${index.ci.headSha}\``);
  } else {
    lines.push("- CI run: not generated inside GitHub Actions.");
  }
  lines.push("");

  lines.push("## Local quality");
  lines.push("");
  lines.push(`- Scope: ${index.localQuality.scope}`);
  lines.push(`- Canonical command: \`${index.localQuality.canonicalCommand}\``);
  lines.push(`- Local success: **${index.localQuality.success ? "PASS" : "FAIL"}**`);
  if (index.localQuality.counts) {
    const counts = index.localQuality.counts;
    lines.push(`- Gates: ${counts.passed} passed, ${counts.failed} failed, ${counts.notRun} not run`);
  }
  if (index.localQuality.blocked.length > 0) {
    lines.push(`- Blocked: ${index.localQuality.blocked.map((id) => `\`${id}\``).join(", ")}`);
  }
  lines.push("");

  lines.push("## Deployment and release state");
  lines.push("");
  lines.push(`- Release ready: **${index.deployment.releaseReady ? "yes" : "no"}**`);
  lines.push(`- Deployed-host evidence: **${index.deployment.deployedHostEvidence}**`);
  lines.push(`- ${index.deployment.statement}`);
  for (const gate of index.deployment.deferredGates) {
    lines.push(`- \`${gate.id}\` — ${gate.status} (${gate.ownership}-owned, deferred)`);
  }
  lines.push("");

  lines.push("## Production artifact");
  lines.push("");
  lines.push(`- Manifest format: \`${index.artifact.manifestFormat}\``);
  lines.push(`- Provenance repository: \`${index.artifact.provenance.repository}\``);
  lines.push(`- Provenance commit: \`${index.artifact.provenance.commit}\``);
  lines.push(`- Packaged files: ${index.artifact.fileCount}`);
  lines.push(`- \`${index.artifact.tarball.path}\` — ${index.artifact.tarball.bytes} bytes`);
  lines.push(`- SHA-256: \`${index.artifact.tarball.sha256}\``);
  lines.push("");

  lines.push("## Explicit evidence");
  lines.push("");
  lines.push("| Gate | Stage | Status |");
  lines.push("| --- | --- | --- |");
  for (const gate of index.explicitEvidence) {
    lines.push(`| \`${gate.id}\` | ${gate.stage} | ${gate.status} |`);
  }
  lines.push("");

  lines.push("## Baseline families");
  lines.push("");
  lines.push("| Family | Prefix | Supporting gates |");
  lines.push("| --- | --- | --- |");
  for (const baseline of index.baselines) {
    lines.push(
      `| ${baseline.family} | ${baseline.domainPrefix} | ${baseline.gateIds.map((id) => `\`${id}\``).join(", ")} |`,
    );
  }
  lines.push("");

  lines.push("## Every gate");
  lines.push("");
  lines.push("| Gate | Stage | Status | Required | Ownership |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const gate of index.gates) {
    lines.push(
      `| \`${gate.id}\` | ${gate.stage} | ${gate.status} | ${gate.required ? "yes" : "no (deferred)"} | ${gate.ownership} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Materialise the bundle directory: payload files first, then the index that
 * hashes them, then the digest of that index.
 */
export function generateEvidenceBundle({
  outDir,
  reportPath,
  manifestPath = join(repoRoot, "dist", "eszter-production", "ARTIFACT-MANIFEST.json"),
  tarballPath = join(repoRoot, "dist", "eszter-production.tar.gz"),
  env = process.env,
  generatedAt = null,
}) {
  const validationReport = readJson(reportPath, "validation report");
  const artifactManifest = readJson(manifestPath, "production artifact manifest");

  if (!existsSync(tarballPath)) {
    throw new Error(`production tarball is missing at ${tarballPath} — deployment:artifact must run first`);
  }

  const tarball = {
    path: `dist/${basename(tarballPath)}`,
    bytes: statSync(tarballPath).size,
    sha256: sha256File(tarballPath),
  };

  const index = buildEvidenceIndex({
    validationReport,
    artifactManifest,
    tarball,
    ci: githubActionsContext(env),
    generatedAt,
  });

  // A CI-generated bundle must be about the commit CI attested. Anything else
  // means the checkout and the run disagree, and the bundle is worthless.
  if (index.ci?.present && index.ci.headSha && index.ci.headSha !== index.candidate.commit) {
    throw new Error(
      `CI head SHA ${index.ci.headSha} does not match the validated candidate ${index.candidate.commit}`,
    );
  }

  mkdirSync(outDir, { recursive: true });

  const payload = [
    { name: BUNDLE_FILES.validationReport, source: reportPath, role: "canonical validation report" },
    { name: BUNDLE_FILES.artifactManifest, source: manifestPath, role: "production artifact manifest" },
    { name: BUNDLE_FILES.tarball, source: tarballPath, role: "production artifact archive" },
  ];
  for (const entry of payload) {
    const destination = join(outDir, entry.name);
    // The bundle is allowed to be generated into the directory that already
    // holds the canonical report (that is how CI lays it out, so a downloaded
    // artifact IS the bundle). Copying a file onto itself would truncate it.
    if (resolve(entry.source) !== resolve(destination)) copyFileSync(entry.source, destination);
  }

  // The Markdown companion is rendered from the index before the index seals
  // it, so the index can carry its digest like any other payload file.
  const markdownPath = join(outDir, BUNDLE_FILES.markdown);
  writeAtomic(markdownPath, renderIndexMarkdown(index));

  index.files = [...payload.map((entry) => ({ name: entry.name, role: entry.role })), {
    name: BUNDLE_FILES.markdown,
    role: "human-readable index",
  }]
    .map((entry) => {
      const path = join(outDir, entry.name);
      return { path: entry.name, role: entry.role, bytes: statSync(path).size, sha256: sha256File(path) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const sensitive = sensitiveFieldProblems(index);
  if (sensitive.length > 0) {
    throw new Error(`refusing to write an evidence index carrying sensitive fields:\n  - ${sensitive.join("\n  - ")}`);
  }

  const indexPath = join(outDir, BUNDLE_FILES.index);
  writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // One digest that names the whole bundle. It identifies the bundle and
  // catches corruption of the index; it is not a signature, and the real
  // binding is the candidate commit plus the per-file digests inside.
  const bundleSha256 = sha256File(indexPath);
  writeAtomic(join(outDir, BUNDLE_FILES.bundleDigest), `${bundleSha256}  ${BUNDLE_FILES.index}\n`);

  return { index, indexPath, outDir, bundleSha256 };
}

/**
 * Fail-closed verification of a bundle directory.
 *
 * Returns the list of problems; an empty list means every invariant held.
 * The expected repository/commit are trusted inputs: derived from the
 * enclosing checkout, or supplied explicitly for a bundle downloaded outside
 * a repository. Without either, verification fails rather than trusting the
 * bundle's own claim about itself.
 */
export function verifyEvidenceBundle(bundleDir, { expectedRepository = null, expectedCommit = null } = {}) {
  const problems = [];
  const indexPath = join(bundleDir, BUNDLE_FILES.index);

  let index;
  try {
    index = readJson(indexPath, "evidence index");
  } catch (error) {
    return [error.message];
  }

  if (index.format !== EVIDENCE_BUNDLE_FORMAT) {
    return [`evidence index format is not ${EVIDENCE_BUNDLE_FORMAT}: ${JSON.stringify(index.format)}`];
  }

  // ── Candidate binding ──────────────────────────────────────────────────
  const candidate = index.candidate ?? {};
  if (!isCanonicalRepository(candidate.repository)) {
    problems.push(`candidate repository is not ${CANONICAL_REPOSITORY}: ${JSON.stringify(candidate.repository)}`);
  }
  if (typeof candidate.commit !== "string" || !COMMIT_SHA_PATTERN.test(candidate.commit)) {
    problems.push(`candidate commit is not a 40-character lowercase hex SHA: ${JSON.stringify(candidate.commit)}`);
  }
  if (expectedRepository === null || expectedCommit === null) {
    problems.push(
      "no trusted expected repository/commit: verification needs an enclosing checkout or explicit --expect-repository/--expect-commit",
    );
  } else {
    if (!isCanonicalRepository(expectedRepository)) {
      problems.push(`trusted expected repository is not ${CANONICAL_REPOSITORY}: ${JSON.stringify(expectedRepository)}`);
    } else if (!isCanonicalRepository(candidate.repository)) {
      // already reported
    } else if (candidate.repository !== CANONICAL_REPOSITORY) {
      problems.push(`candidate repository ${candidate.repository} is not the canonical spelling`);
    }
    if (!COMMIT_SHA_PATTERN.test(String(expectedCommit))) {
      problems.push(`trusted expected commit is not a 40-character lowercase hex SHA: ${JSON.stringify(expectedCommit)}`);
    } else if (candidate.commit !== expectedCommit) {
      problems.push(`candidate commit ${candidate.commit} does not match attested commit ${expectedCommit}`);
    }
  }

  // ── Referenced files re-hashed ─────────────────────────────────────────
  if (!Array.isArray(index.files) || index.files.length === 0) {
    problems.push("evidence index references no files");
  } else {
    for (const entry of index.files) {
      const path = join(bundleDir, entry.path);
      if (entry.path.includes("..") || entry.path.startsWith("/")) {
        problems.push(`referenced file path escapes the bundle: ${entry.path}`);
        continue;
      }
      if (!existsSync(path)) {
        problems.push(`referenced file is missing from the bundle: ${entry.path}`);
        continue;
      }
      const actual = sha256File(path);
      if (actual !== entry.sha256) {
        problems.push(`referenced file ${entry.path} does not match its recorded SHA-256 (recorded ${entry.sha256}, actual ${actual})`);
      }
      const bytes = statSync(path).size;
      if (typeof entry.bytes === "number" && bytes !== entry.bytes) {
        problems.push(`referenced file ${entry.path} is ${bytes} bytes, recorded ${entry.bytes}`);
      }
    }
  }

  // ── Bundle digest ──────────────────────────────────────────────────────
  const digestPath = join(bundleDir, BUNDLE_FILES.bundleDigest);
  if (!existsSync(digestPath)) {
    problems.push(`bundle digest ${BUNDLE_FILES.bundleDigest} is missing`);
  } else {
    const recorded = readFileSync(digestPath, "utf8").trim().split(/\s+/)[0];
    const actual = sha256File(indexPath);
    if (recorded !== actual) {
      problems.push(`bundle digest does not match ${BUNDLE_FILES.index} (recorded ${recorded}, actual ${actual})`);
    }
  }

  // ── Artifact provenance ────────────────────────────────────────────────
  const artifact = index.artifact ?? {};
  const provenanceErrors = attestationErrors(artifact.provenance, candidate.repository, candidate.commit);
  for (const error of provenanceErrors) problems.push(`artifact provenance: ${error}`);

  const tarball = artifact.tarball ?? {};
  if (typeof tarball.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(tarball.sha256)) {
    problems.push(`production tarball SHA-256 is missing or malformed: ${JSON.stringify(tarball.sha256)}`);
  } else {
    const bundled = join(bundleDir, BUNDLE_FILES.tarball);
    if (!existsSync(bundled)) {
      problems.push(`production tarball ${BUNDLE_FILES.tarball} is missing from the bundle`);
    } else {
      const actual = sha256File(bundled);
      if (actual !== tarball.sha256) {
        problems.push(
          `production tarball does not match the recorded SHA-256 (recorded ${tarball.sha256}, actual ${actual})`,
        );
      }
    }
  }

  // The bundled validation report must be the one the index was built from.
  const bundledReportPath = join(bundleDir, BUNDLE_FILES.validationReport);
  if (!existsSync(bundledReportPath)) {
    problems.push(`canonical validation report ${BUNDLE_FILES.validationReport} is missing from the bundle`);
  } else {
    let bundledReport = null;
    try {
      bundledReport = readJson(bundledReportPath, "bundled validation report");
    } catch (error) {
      problems.push(error.message);
    }
    if (bundledReport) {
      for (const problem of validationReportProblems(bundledReport)) {
        problems.push(`bundled validation report: ${problem}`);
      }
      if (bundledReport.candidate?.commit && bundledReport.candidate.commit !== candidate.commit) {
        problems.push(
          `bundled validation report attests ${bundledReport.candidate.commit}, index attests ${candidate.commit}`,
        );
      }
      const reportIds = new Set((bundledReport.gates ?? []).map((gate) => gate.id));
      for (const gate of index.gates ?? []) {
        if (!reportIds.has(gate.id)) {
          problems.push(`index gate ${gate.id} does not exist in the bundled validation report`);
        }
      }
    }
  }

  // ── Gate invariants ────────────────────────────────────────────────────
  const gates = Array.isArray(index.gates) ? index.gates : [];
  if (gates.length === 0) problems.push("evidence index carries no gate results");
  const byId = new Map(gates.map((gate) => [gate.id, gate]));

  for (const gate of gates) {
    if (gate.deferred === true) continue;
    if (gate.required !== true) {
      problems.push(`gate ${gate.id} is neither required nor deferred — the policy admits no third kind`);
    }
    if (gate.status !== PASS) {
      problems.push(`required gate ${gate.id} did not PASS: ${gate.status}`);
    }
  }

  // Exactly the two deployment-owned gates are deferred, and both are still
  // NOT RUN. A bundle that quietly turned one into a PASS is refused.
  const deferredIds = gates.filter((gate) => gate.deferred === true).map((gate) => gate.id).sort();
  const expectedDeferred = [...DEFERRED_LIVE_GATES].sort();
  if (deferredIds.join(",") !== expectedDeferred.join(",")) {
    problems.push(
      `deferred gates must be exactly ${expectedDeferred.join(", ")}; found ${deferredIds.join(", ") || "none"}`,
    );
  }
  for (const id of deferredIds) {
    const gate = byId.get(id);
    if (gate.status !== NOT_RUN) {
      problems.push(`deferred gate ${id} must remain ${NOT_RUN}, found ${gate.status}`);
    }
    if (gate.ownership !== "deployment") {
      problems.push(`deferred gate ${id} must be deployment-owned, found ${JSON.stringify(gate.ownership)}`);
    }
    if (gate.required === true) {
      problems.push(`deferred gate ${id} must not be required`);
    }
  }

  // ── Explicit evidence ──────────────────────────────────────────────────
  const declaredExplicit = new Map((index.explicitEvidence ?? []).map((entry) => [entry.id, entry]));
  for (const id of EXPLICIT_EVIDENCE_GATES) {
    const entry = declaredExplicit.get(id);
    if (!entry) {
      problems.push(`explicit evidence for ${id} is missing from the index`);
      continue;
    }
    const gate = byId.get(id);
    if (!gate) {
      problems.push(`explicit evidence names ${id}, which no gate result declares`);
      continue;
    }
    if (entry.status !== gate.status) {
      problems.push(`explicit evidence for ${id} claims ${entry.status}, the gate result says ${gate.status}`);
    }
    if (gate.status !== PASS) {
      problems.push(`explicit evidence gate ${id} did not PASS: ${gate.status}`);
    }
  }
  for (const id of declaredExplicit.keys()) {
    if (!byId.has(id)) problems.push(`explicit evidence names unknown gate id ${id}`);
  }

  // ── Baseline families ──────────────────────────────────────────────────
  const baselines = Array.isArray(index.baselines) ? index.baselines : [];
  const seen = new Set();
  for (const baseline of baselines) {
    if (seen.has(baseline.family)) {
      problems.push(`baseline family ${baseline.family} is declared more than once`);
      continue;
    }
    seen.add(baseline.family);
    const expected = BASELINE_FAMILIES.find((entry) => entry.family === baseline.family);
    if (!expected) {
      problems.push(`unknown baseline family ${JSON.stringify(baseline.family)}`);
      continue;
    }
    if (baseline.domainPrefix !== expected.domainPrefix) {
      problems.push(`baseline ${baseline.family}: domainPrefix must be ${expected.domainPrefix}`);
    }
    const ids = Array.isArray(baseline.gateIds) ? baseline.gateIds : [];
    if (ids.length === 0) {
      problems.push(`baseline ${baseline.family} maps no supporting gate`);
    }
    for (const id of ids) {
      const gate = byId.get(id);
      if (!gate) {
        problems.push(`baseline ${baseline.family} maps unknown gate id ${id}`);
        continue;
      }
      if (gate.status !== PASS) {
        problems.push(`baseline ${baseline.family} is supported by ${id}, which did not PASS: ${gate.status}`);
      }
    }
  }
  for (const expected of BASELINE_FAMILIES) {
    if (!seen.has(expected.family)) problems.push(`baseline family ${expected.family} is missing from the index`);
  }

  // ── Local quality vs release state ─────────────────────────────────────
  if (index.localQuality?.success !== true) {
    problems.push("local quality is not a success — this bundle does not attest a passing candidate");
  }
  if (index.deployment?.releaseReady !== false) {
    problems.push('deployment.releaseReady must be false — "release ready" is never derived from local success');
  }
  if (index.deployment?.deployedHostEvidence !== "pending") {
    problems.push(
      `deployment.deployedHostEvidence must be "pending", found ${JSON.stringify(index.deployment?.deployedHostEvidence)}`,
    );
  }

  // ── CI coherence ───────────────────────────────────────────────────────
  if (index.ci?.present === true && index.ci.headSha && index.ci.headSha !== candidate.commit) {
    problems.push(`CI head SHA ${index.ci.headSha} does not match the candidate commit ${candidate.commit}`);
  }

  // ── Sensitive content ──────────────────────────────────────────────────
  problems.push(...sensitiveFieldProblems(index).map((problem) => `sensitive content: ${problem}`));

  return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function optionValue(argv, name) {
  const index = argv.findIndex((argument) => argument === name || argument.startsWith(`${name}=`));
  if (index === -1) return null;
  return argv[index].startsWith(`${name}=`) ? argv[index].slice(name.length + 1) : (argv[index + 1] ?? null);
}

function trustedExpectations(argv) {
  const repository = optionValue(argv, "--expect-repository");
  const commit = optionValue(argv, "--expect-commit");
  if (repository !== null && commit !== null) {
    return { expectedRepository: repository, expectedCommit: commit };
  }
  // Fall back to the enclosing checkout when it is available; a bundle
  // downloaded outside a repository must supply both --expect-* values.
  try {
    return {
      expectedRepository: repository ?? resolveRepositoryIdentity(repoRoot),
      expectedCommit: commit ?? resolveHeadCommit(repoRoot),
    };
  } catch {
    return { expectedRepository: repository, expectedCommit: commit };
  }
}

const USAGE = [
  "Usage:",
  "  node scripts/evidence-bundle.mjs generate --report <path> --out <dir> [--manifest <path>] [--tarball <path>]",
  "  node scripts/evidence-bundle.mjs verify --bundle <dir> [--expect-repository <owner/repo>] [--expect-commit <sha>]",
  "",
  "generate builds a versioned candidate evidence bundle from ONE canonical",
  "validation report (scripts/validate.mjs --report / ESZTER_VALIDATION_REPORT)",
  "plus the existing production artifact outputs. It runs no gate and decides",
  "no gate outcome.",
  "",
  "verify re-hashes every referenced file and enforces the candidate,",
  "provenance, gate, baseline and non-disclosure invariants. Exit 0 = every",
  "invariant held, 1 = at least one did not, 2 = usage error.",
  "",
].join("\n");

function main(argv) {
  const command = argv[0];

  if (!command || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }

  if (command === "generate") {
    const reportPath = optionValue(argv, "--report") ?? process.env.ESZTER_VALIDATION_REPORT ?? null;
    const outDir = optionValue(argv, "--out");
    if (!reportPath || !outDir) {
      process.stderr.write("evidence-bundle: generate needs --report <path> and --out <dir>\n");
      return 2;
    }
    const manifestPath = optionValue(argv, "--manifest");
    const tarballPath = optionValue(argv, "--tarball");
    try {
      const { index, outDir: written, bundleSha256 } = generateEvidenceBundle({
        outDir: resolve(process.cwd(), outDir),
        reportPath: resolve(process.cwd(), reportPath),
        ...(manifestPath ? { manifestPath: resolve(process.cwd(), manifestPath) } : {}),
        ...(tarballPath ? { tarballPath: resolve(process.cwd(), tarballPath) } : {}),
      });
      process.stdout.write(
        `Evidence bundle written: ${written}\n`
          + `  candidate: ${index.candidate.repository}@${index.candidate.commit}\n`
          + `  gates: ${index.gates.length} (${index.deployment.deferredCount} deferred, still NOT RUN)\n`
          + `  baselines: ${index.baselines.length} families\n`
          + `  artifact: ${index.artifact.tarball.path} sha256=${index.artifact.tarball.sha256}\n`
          + `  index.json sha256=${bundleSha256}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`evidence-bundle: generate failed: ${error?.message ?? error}\n`);
      return 1;
    }
  }

  if (command === "verify") {
    const bundleDir = optionValue(argv, "--bundle");
    if (!bundleDir) {
      process.stderr.write("evidence-bundle: verify needs --bundle <dir>\n");
      return 2;
    }
    const problems = verifyEvidenceBundle(resolve(process.cwd(), bundleDir), trustedExpectations(argv));
    if (problems.length > 0) {
      process.stderr.write("Candidate evidence INVALID\n");
      for (const problem of problems) process.stderr.write(`- ${problem}\n`);
      return 1;
    }
    const index = readJson(join(resolve(process.cwd(), bundleDir), BUNDLE_FILES.index), "evidence index");
    process.stdout.write(
      `Candidate evidence OK: ${index.candidate.repository}@${index.candidate.commit}\n`
        + `  ${index.gates.length} gates, every required gate PASS, `
        + `${index.deployment.deferredCount} deployment-owned gate(s) still NOT RUN\n`
        + `  ${index.baselines.length} baseline families mapped, ${index.files.length} referenced files re-hashed\n`
        + `  Local quality only — deployed-host evidence ${index.deployment.deployedHostEvidence}, not a release PASS\n`,
    );
    return 0;
  }

  process.stderr.write(`evidence-bundle: unknown command ${JSON.stringify(command)}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
