# Simfile Coverage

This folder owns the auditable design-to-implementation manifest for Simfile.

## Files

- `matrix.ts` is the authoritative coverage manifest: the frozen top-level key rows and the seven audit-primitive rows, each with a subject, a claim, a spec reference, a status, and evidence.
- `render.ts` exports `renderCoverageMarkdown`, a deterministic Markdown renderer over the manifest rows.
- `index.ts` is the coverage barrel.
- `matrix.test.ts` enforces the manifest's grammar and its parity with `docs/SYSTEMS_VIEW.md` and the generated document.

## Rules

- `matrix.ts` is authoritative. `docs/COVERAGE.md` is generated from it via `npm run coverage:render` (see `scripts/render-coverage.ts`); never hand-edit `docs/COVERAGE.md`.
- `evidence` must always be a concrete repository path (a `src/` or `scripts/` file, or an upper-case `*.md` document), never a description or a claim restated in prose.
- `status` is limited to `implemented`, `deferred`, or a provable `planned:B<id>` tied to a repo-local active Burnlist registry. Do not mark schema acceptance alone as implementation of a deferred subclaim.
- No default exports.
