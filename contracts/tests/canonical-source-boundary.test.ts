import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * ESZ-109 / AUD-32 — the generated-artifact boundary.
 *
 * The committed files under `contracts/generated/` are **outputs**. They are
 * what a non-TypeScript implementation consumes (PHP reads them, the drift
 * tests in `generated-artifacts.test.ts` verify them byte-for-byte), so a
 * canonical contract source that imports or reads them would make the
 * generator's own output an input to the next generation — a loop in which a
 * stale artifact can no longer be detected because the source would be
 * re-deriving itself from it.
 *
 * This suite is the deterministic guard over every `.ts` module at the
 * contracts root (the canonical sources the barrel and the generator are
 * built from):
 *
 * 1. outside comments, no `generated/` path segment may appear at all — in an
 *    import/export specifier, a dynamic `import()`, a `require()`, a
 *    `readFile*` argument, a `new URL(...)`, or any data string. Comments are
 *    documentation, not dependencies, so they are removed first; the path
 *    scan then runs over the remaining raw text with string literals kept,
 *    because replacing a string literal would hide the very specifier being
 *    forbidden.
 * 2. outside comments and string literals, no filesystem or module-loading
 *    machinery (`readFile*`, `require(`, `import(`) may appear. This ban
 *    exists because the indirection `readFileSync(join(GENERATED, file))`
 *    would otherwise evade a literal-path scan; a canonical contract module
 *    is pure data and types, so no such call has a legitimate use here.
 * 3. no `node:` builtin import — the only builtins that could matter here are
 *    the filesystem ones.
 *
 * The verification suites under `contracts/tests/` and the generator under
 * `contracts/scripts/` are deliberately NOT scanned: reading the artifacts is
 * their job, and the boundary being protected is the canonical source's, not
 * the verifier's.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical sources = every `.ts` module at the contracts root. */
const canonicalSources = readdirSync(ROOT)
  .filter((entry) => entry.endsWith(".ts"))
  .sort();

/**
 * Removes `/* … *​/` and `// …` comments with a single pass that skips string
 * literals, so a `//` inside a string (a URL, a message) can never be
 * mistaken for a comment and hide the rest of its line from the scans.
 */
function stripComments(code: string): string {
  let out = "";
  let state: "code" | "string" = "code";
  let quote = "";
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (state === "string") {
      out += char;
      if (char === "\\") {
        out += code[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        state = "code";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      state = "string";
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) {
        if (code[index] === "\n") out += "\n";
        index += 1;
      }
      index += 1; // closing '/'
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Replaces '…', "…" and `…` literals with placeholders (escapes honoured), so
 * the identifier scans never trip on data that merely mentions a token.
 */
function protectStringLiterals(code: string): string {
  return code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gs, (literal) =>
    " ".repeat(Math.max(1, literal.length - 1)).concat("S"),
  );
}

/** Comments are documentation; everything else must stay path- and I/O-free. */
function isClean(code: string): boolean {
  const noComments = stripComments(code);
  const noCommentsNoStrings = protectStringLiterals(noComments);
  return !/generated\//.test(noComments)
    && !/\breadFile\w*\s*\(/.test(noCommentsNoStrings)
    && !/\brequire\s*\(/.test(noCommentsNoStrings)
    && !/\bimport\s*\(/.test(noCommentsNoStrings)
    && !/\bfrom\s*["']node:/.test(noComments);
}

test("the canonical source set is exactly the contracts-root .ts modules", () => {
  assert.deepEqual(canonicalSources, [
    "appearance.ts",
    "booking.ts",
    "content-envelopes.ts",
    "default-site-content.ts",
    "http-contract.ts",
    "index.ts",
    "parity-runtime.ts",
    "semantic-rules.ts",
    "site-content.ts",
  ]);
});

test("no canonical source imports or reads contracts/generated/*", () => {
  const violations: string[] = [];
  for (const fileName of canonicalSources) {
    const code = readFileSync(join(ROOT, fileName), "utf8");
    if (!isClean(code)) violations.push(fileName);
  }
  assert.deepEqual(
    violations,
    [],
    "a canonical contract source references contracts/generated/ or filesystem machinery: "
      + "generated files are outputs only and must never be an input to canonical TypeScript.",
  );
});

test("the detector is not vacuous: planted violations are caught, comments are not (red-proof)", () => {
  const plantedImport = 'import doc from "./generated/booking-domain.json";';
  const plantedLiteralRead = 'const raw = readFileSync(ROOT + "/generated/http-contract.json");';
  const plantedIndirectRead = 'const raw = readFileSync(join(GENERATED, "http-contract.json"));';
  const plantedRequire = 'const manifest = require("../generated/manifest.json");';
  const plantedDynamicImport = 'const doc = await import("./generated/booking-domain.json");';
  const plantedNodeImport = 'import { readFileSync } from "node:fs";';
  const plantedUrl = 'const message = "see https://example.test/generated/x for details";';
  const plantedInComment = "// readFileSync('./generated/semantic-rules.json') is only a comment";
  const plantedInBlockComment = "/* reads contracts/generated/http-contract.json */";
  const generatedWordInString = 'const expectation = "generated"; // no path segment';
  // A URL string on the same line must not swallow the code after it.
  const violationAfterUrl =
    'const url = "https://example.test/";\nconst raw = readFileSync("./generated/manifest.json");';

  for (const planted of [
    plantedImport,
    plantedLiteralRead,
    plantedIndirectRead,
    plantedRequire,
    plantedDynamicImport,
    plantedNodeImport,
    plantedUrl,
    violationAfterUrl,
  ]) {
    assert.equal(isClean(planted), false, `planted violation passed the scan: ${planted}`);
  }

  // Comments are documentation and a bare word is not a path into the
  // generated directory — neither may trip the scan.
  assert.equal(isClean(plantedInComment), true);
  assert.equal(isClean(plantedInBlockComment), true);
  assert.equal(isClean(generatedWordInString), true);
});
