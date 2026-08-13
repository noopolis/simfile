# Simfile Repository Tools

This folder contains repository-maintenance tools. Resolve repository paths
relative to each tool's own module URL, keep checks read-only, and keep refresh
operations deterministic and fail-closed.

- `refreshVendorStele.mjs` refreshes the integrity-pinned source tarball while
  preserving Simfile's release-safe exact dependency coordinate and bundle.
- `verify-package-closure.mjs` packs and offline-installs Simfile, checks the
  bundled Stele closure and runtime imports, and starts the installed CLI.
