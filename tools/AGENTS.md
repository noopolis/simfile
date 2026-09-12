# Simfile Repository Tools

This folder contains repository-maintenance tools. Resolve repository paths
relative to each tool's own module URL, keep checks read-only, and keep refresh
operations deterministic and fail-closed.

- Maintained tools are strict TypeScript sources and are emitted to
  `dist/tools/` during build for package and installed-consumer checks.
- `verify-package-closure.ts` packs and offline-installs Simfile, checks the
  bundled package closure and runtime imports, and starts the installed CLI.
  Its contract and isolated-install helpers live in
  `package-closure-contract.ts` and `package-closure-install.ts`.
