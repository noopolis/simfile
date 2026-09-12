# Repository Tools

`tools/` holds maintainer checks that are not product entrypoints.

- `verify-package-closure.ts` packs Simfile, installs it offline in an isolated
  consumer project, checks that runtime dependencies resolve from the package
  graph, verifies the installed CLI, and proves the emitted development command
  modules are usable from the installed package.
- `package-closure-contract.ts` contains package-manifest and tarball-entry
  assertions.
- `package-closure-install.ts` contains the isolated install and packed-example
  probes.

These tools are TypeScript source in the repository and emitted to
`dist/tools/` during build so package-closure verification does not rely on
TypeScript files inside `node_modules`.
