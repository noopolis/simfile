# Simfile Spawnfile Boundary

This folder is Simfile's generic public-neutral boundary for Spawnfile
lifecycle subprocesses and the documented versioned JSON receipts they emit.

- `cli.ts` shells only the documented high-level composed preparation command,
  `spawnfile up`, `spawnfile artifacts export`, and `spawnfile down` through
  Node. Composed preparation supplies private target configuration only on
  stdin, captures stdout separately from stderr, and removes its temporary
  secret-free request file. This boundary must never import Spawnfile
  TypeScript internals or invoke Docker directly.
- `process.ts` owns bounded subprocess execution, in-flight cancellation, and
  nonsecret target-config producer argv execution; private bytes remain in memory.
- `receipts.ts` owns additive-tolerant validation of the public JSON wire
  receipts. Keep the SHA-256 validation, strict identity/correlation checks,
  and secret-shape rejection; do not substitute Spawnfile's internal schemas.
- `preparationReceipt.ts` owns Simfile's independent additive-tolerant parser
  for the documented Spawnfile composed-preparation request/receipt pair.
- `targetReceipts.ts` independently validates public target-operation, readiness,
  and bounded public-artifact wire receipts.
- `evidenceInventory.ts` derives B14 only from Spawnfile's byte-derived,
  source-bound public evidence export index and rejects unknown or incomplete inventories.
- `worldEvidenceArchive.ts` validates that byte-derived index against the private canonical
  target USTAR export and atomically materializes it for sealed-record assembly.
- `productionTarget.ts` recreates private config in memory for each public target call and
  gates both producer and Spawnfile subprocesses on the pinned journal session.
- `productionPorts.ts` maps the composed lifecycle to documented Spawnfile CLI operations;
  `productionOrganizationPorts.ts` owns the organization-start port slice.
- `productionTerminal.ts` polls only the bounded world-owned public terminal artifact.
- `productionViewerProjection.ts` polls one declared world-owned public viewer
  artifact through the same verified read-only target operation. Its bound
  finalization port makes one bounded terminal attempt after the durable
  terminal receipt and before destructive world pause; errors are observer-only.
- `preparationReceipt.test-helper.ts` builds shared secret-free wire fixtures
  used by the preparation parser and subprocess-boundary tests.
- `index.ts` is the external `simfile/spawnfile` contract. Export only its
  documented generic lifecycle and receipt API; no domain or provider-client
  surface belongs here.

Keep files below 400 lines, use named exports, and place tests beside the
boundary they prove.
