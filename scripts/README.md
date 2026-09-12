# Development Scripts

These scripts are maintained TypeScript source. Source checkouts run them after
`npm run build` through the emitted JavaScript under `dist/scripts/`, while
source-only maintenance such as coverage rendering uses Node's native type
stripping.

The scripts do repository-local development work only:

- `run-tests.ts` runs the local Node test suite and rejects empty or cancelled
  TAP runs.
- `simfile-local-example.ts` runs the checked-in local example through the
  freshly built CLI.
- `spawnfile-development.ts` owns isolated Spawnfile setup, status, and check
  commands under `.simfile-dev/`.
- `spawnfile-composed-smoke.ts` runs the composed smoke path after proving the
  selected Spawnfile endpoint is local.
- `spawnfile-capability-probe.ts`, `spawnfile-local-endpoint.ts`,
  `spawnfile-install-integrity.ts`, and `spawnfile-source-stage.ts` are shared
  helpers for those entrypoints.
- `render-coverage.ts` regenerates `docs/COVERAGE.md` from source coverage
  metadata.

Do not import Spawnfile source or infer sibling checkouts here. Inputs must be
explicit package coordinates, artifacts, or absolute source paths.
