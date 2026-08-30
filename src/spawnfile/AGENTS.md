# Simfile Spawnfile Boundary

This folder is Simfile's generic public-neutral boundary for Spawnfile
lifecycle subprocesses and the documented versioned JSON receipts they emit.

- `cli.ts` is the CLI barrel; the high-level, lifecycle, evidence, and target
  command wrappers are split across the adjacent `*Cli.ts` modules. This
  boundary must never import Spawnfile TypeScript internals or invoke Docker
  directly. Its legacy stdin helpers are not a composed product path.
- `process.ts` owns bounded subprocess execution, while `processTree.ts` and
  `executableIdentity.ts` own quiescence and exact bootstrap executable identity.
- `receipts.ts` owns additive-tolerant validation of the public JSON wire
  receipts. Keep the SHA-256 validation, strict identity/correlation checks,
  and secret-shape rejection; do not substitute Spawnfile's internal schemas.
- `preparationReceipt.ts` owns Simfile's independent additive-tolerant parser
  for the documented Spawnfile composed-preparation request/receipt pair.
- `targetReceipts.ts` is the receipt barrel; `targetResourceReceipts.ts`,
  `targetWorldReceipts.ts`, and `targetPublicArtifact.ts` independently validate
  public target-operation, readiness, and bounded public-artifact receipts.
- `evidenceInventory.ts` derives B14 only from Spawnfile's byte-derived,
  source-bound public evidence export index and rejects unknown or incomplete inventories.
- `worldEvidenceArchive.ts` validates that byte-derived index against the private canonical
  target USTAR export and atomically materializes it for sealed-record assembly.
- `targetBootstrap.ts` consumes the exact resolver/selection/container-bundle
  receipts under the v2 bootstrap journal. `composedTargetProvider.ts` is the
  resolver-backed, journal-aware provider; `targetOperationLookup.ts` and
  `lifecycleLookup.ts` independently parse typed recovery observations.
- `productionTarget.ts` gates target requests on the pinned journal session and
  delegates them only through that provider seam. `productionPorts.ts` is the
  production barrel; the adjacent `production*Ports.ts` modules map the world,
  topology, organization, finalization, and cleanup boundaries.
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

Keep changed production files at or below 200 lines, use named exports, and place tests beside the
boundary they prove.
