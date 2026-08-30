# Development Script Guide

This folder contains bounded repository-development entrypoints. Scripts may
prepare isolated state beneath ignored repository directories, but they must
not infer sibling checkouts, global package installations, remote targets, or
credentials.

- Keep source/package inputs explicit and validate physical paths before use.
- Install external developer tools into `.simfile-dev/`, never `node_modules/`
  or another repository's dependency graph.
- Run the Simfile-owned, generic public-CLI capability preflight before
  lifecycle or Docker mutation. Never require a Simfile-specific Spawnfile
  profile or receipt.
- Prefer versioned JSON receipts so tests and documentation can make exact
  claims about what a setup proves.
- Every loop, poll, and subprocess wait must have a finite end condition.
- `spawnfile-development.mjs` dispatches setup/check/status; its context and
  install transaction live in `spawnfile-development-context.mjs` and
  `spawnfile-development-setup.mjs`.
- `spawnfile-composed-smoke.mjs` must prove the selected endpoint is local via
  `spawnfile-local-endpoint.mjs` before it starts the built Simfile CLI.
