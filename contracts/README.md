# Eszter Contracts

Private shared runtime contract package for the Eszter project.

Package name:

```text
@eszter/contracts
```

It exports the Zod schemas, schema-version constants, stable-ID constants, inferred TypeScript types, the canonical `defaultSiteAppearance`, the canonical `defaultSiteContent`, the frozen HTTP contract (`http-contract.ts`) and the semantic-rule registry (`semantic-rules.ts`).

The package is framework-independent. It has no React, Next.js, server-framework, browser or filesystem dependency.

## Commands

```bash
cd contracts
npm install
npm run typecheck          # package sources
npm run typecheck:tools    # scripts/ and tests/
npm run generate           # regenerate generated/ from the Zod schemas
npm run verify:generated   # fail if generated/ is stale
npm test                   # parity corpus, rule coverage, drift
npm run build
```

The package compiles TypeScript sources to `dist/`. `front/` consumes it through `file:../contracts` and resolves package exports from `dist/`. It is the only Node consumer since the Express service was retired in ESZ-015; the PHP backend reads `generated/` as data instead.

`contracts` does not build from an npm `prepare` lifecycle. Standalone development requires installing its own dependencies first, then running `npm run build`. This keeps local-package installation safe on hosts such as Vercel where the frontend installs `file:../contracts` before `contracts/node_modules/.bin/tsc` exists.

## Appearance

`SiteContent` includes a framework-independent `appearance` object:

- `palette.background`
- `palette.surface`
- `palette.text`
- `palette.mutedText`
- `palette.primary`
- `palette.secondary`
- `palette.warmAccent`
- `sectionTints.navigation`
- `sectionTints.hero`
- `sectionTints.reassurance`
- `sectionTints.services`
- `sectionTints.process`
- `sectionTints.gallery`
- `sectionTints.about`
- `sectionTints.contact`
- `sectionTints.footer`

Colors accept only six-digit `#RRGGBB` hex values and are normalized to uppercase. CSS names, short hex, alpha hex, functions, variables and gradient strings are rejected.

`defaultSiteAppearance` preserves the current visual identity:

```text
background  #F5F4F1
surface     #FAFAF8
text        #2C2B28
mutedText   #6D6B67
primary     #63726C
secondary   #A8AEB8
warmAccent  #D3D1CD
```

The schema validates contrast for primary text and muted text. Button foregrounds are not stored; clients compute readable `#FFFFFF` or `#1D1C1A` foregrounds from relative luminance.

Legacy `SiteContent` objects without `appearance` remain valid. Parsing normalizes them in memory with `defaultSiteAppearance`. Partial appearance objects, unknown appearance fields and invalid colors are rejected. The envelope schema version remains `1`.

## Language-neutral artifacts

`contracts/generated/` holds committed, machine-readable artifacts for consumers that
cannot run Node — in practice the PHP backend, which is the only implementation of the
HTTP surface:

- `*.schema.json` — JSON Schema 2020-12, **structural validation only**;
- `semantic-rules.json` — the rules JSON Schema cannot express;
- `parity-corpus.json` — the executable accept/reject corpus;
- `http-contract.json` — the frozen `GET /api/health` and `GET /api/content` behaviour;
- `manifest.json` — index and SHA-256 digests.

Regenerate with `npm run generate` after **any** schema change and commit the result;
`npm test` fails when the committed artifacts drift from the sources.

Two invariants matter:

1. Passing a `*.schema.json` is **necessary but not sufficient**. Every rule in
   `semantic-rules.json` must also be enforced.
2. Top-level contract sources must never import from `generated/`. They are the
   generator's *input*, so importing its output would make regeneration depend on the
   last generation. Until ESZ-015 this was also enforced mechanically, because
   `API/Dockerfile` copied `contracts/*.ts` only; that image is gone, the rule is not.

See `docs/contract-freeze.md` for the full rationale.
