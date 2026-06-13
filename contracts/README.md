# Eszter Contracts

Private shared runtime contract package for the Eszter project.

Package name:

```text
@eszter/contracts
```

It exports the Zod schemas, schema-version constants, stable-ID constants, inferred TypeScript types, and the canonical `defaultSiteContent`.

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
