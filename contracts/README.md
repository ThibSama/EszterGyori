# Eszter Contracts

Private shared runtime contract package for the Eszter project.

Package name:

```text
@eszter/contracts
```

It exports the Zod schemas, schema-version constants, stable-ID constants, inferred TypeScript types, the canonical `defaultSiteAppearance`, and the canonical `defaultSiteContent`.

The package is framework-independent. It has no React, Next.js, Express, browser or filesystem dependency.

## Commands

```powershell
cd E:\Eszter\contracts
npm install
npm run typecheck
npm run build
```

The package compiles TypeScript sources to `dist/`. Both `front/` and `API/` consume it through `file:../contracts` and resolve package exports from `dist/`.

The API Docker image builds this package inside the image from the repository root context. Do not rely on a host-generated `contracts/dist/` for Docker builds.

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
