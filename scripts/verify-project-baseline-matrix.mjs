#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(repoRoot, "docs", "project-baseline-matrix.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

const expected = new Map([
  ["Security", ["SEC", 20]],
  ["Architecture", ["ARCH", 23]],
  ["Quality", ["QUAL", 26]],
  ["Testing", ["TEST", 32]],
  ["Delivery", ["DEL", 34]],
  ["Operations", ["OPS", 36]],
  ["Data", ["DATA", 38]],
  ["Performance", ["PERF", 40]],
]);

const errors = [];

if (matrix.schemaVersion !== 1) {
  errors.push(`schemaVersion must be 1, got ${JSON.stringify(matrix.schemaVersion)}`);
}

if (!matrix.project || matrix.project.repository !== "ThibSama/EszterGyori") {
  errors.push("project.repository must be ThibSama/EszterGyori");
}

if (!/^[0-9a-f]{40}$/.test(matrix.project?.derivationSource?.sha ?? "")) {
  errors.push("project.derivationSource.sha must be a full 40-character Git SHA");
}

if (!Array.isArray(matrix.baselines) || matrix.baselines.length !== expected.size) {
  errors.push(`exactly ${expected.size} baselines must be declared`);
} else {
  const names = new Set();

  for (const baseline of matrix.baselines) {
    const definition = expected.get(baseline.name);
    if (!definition) {
      errors.push(`unexpected baseline ${JSON.stringify(baseline.name)}`);
      continue;
    }

    if (names.has(baseline.name)) {
      errors.push(`baseline ${baseline.name} is declared more than once`);
      continue;
    }
    names.add(baseline.name);

    const [prefix, count] = definition;
    if (baseline.domainPrefix !== prefix) {
      errors.push(`${baseline.name}: domainPrefix must be ${prefix}`);
    }
    if (baseline.domainCount !== count) {
      errors.push(`${baseline.name}: domainCount must be ${count}`);
    }
    if (baseline.repository !== `thib-tooling/${baseline.name.toLowerCase()}-baseline`) {
      errors.push(`${baseline.name}: unexpected repository ${JSON.stringify(baseline.repository)}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(baseline.version ?? "")) {
      errors.push(`${baseline.name}: version must be an exact semantic version`);
    }
    if (!/^[0-9a-f]{40}$/.test(baseline.commitSha ?? "")) {
      errors.push(`${baseline.name}: commitSha must be a full 40-character Git SHA`);
    }

    const active = Array.isArray(baseline.activeDomains) ? baseline.activeDomains : [];
    const na =
      baseline.notApplicableDomains &&
      typeof baseline.notApplicableDomains === "object" &&
      !Array.isArray(baseline.notApplicableDomains)
        ? baseline.notApplicableDomains
        : {};

    const activeSet = new Set(active);
    if (activeSet.size !== active.length) {
      errors.push(`${baseline.name}: activeDomains contains duplicates`);
    }

    const naIds = Object.keys(na);
    const overlap = naIds.filter((id) => activeSet.has(id));
    if (overlap.length) {
      errors.push(`${baseline.name}: domains classified both ACTIVE and N/A: ${overlap.join(", ")}`);
    }

    for (const id of naIds) {
      if (typeof na[id] !== "string" || na[id].trim().length < 20) {
        errors.push(`${baseline.name}: ${id} needs a substantive N/A justification`);
      }
    }

    const classified = new Set([...active, ...naIds]);
    const required = Array.from(
      { length: count },
      (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`,
    );

    const missing = required.filter((id) => !classified.has(id));
    const unknown = [...classified].filter((id) => !required.includes(id));

    if (missing.length) {
      errors.push(`${baseline.name}: unclassified domains: ${missing.join(", ")}`);
    }
    if (unknown.length) {
      errors.push(`${baseline.name}: unknown domains: ${unknown.join(", ")}`);
    }
  }

  for (const name of expected.keys()) {
    if (!names.has(name)) {
      errors.push(`missing baseline ${name}`);
    }
  }
}

if (errors.length) {
  console.error("Project baseline matrix INVALID");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const activeCount = matrix.baselines.reduce((sum, baseline) => sum + baseline.activeDomains.length, 0);
const naCount = matrix.baselines.reduce(
  (sum, baseline) => sum + Object.keys(baseline.notApplicableDomains).length,
  0,
);

console.log(
  `Project baseline matrix OK: ${matrix.baselines.length} baselines, ${activeCount} ACTIVE domains, ${naCount} N/A domains, ${activeCount + naCount} classified.`,
);
