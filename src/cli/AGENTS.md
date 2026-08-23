# Simfile CLI

This folder contains the thin command-line wrapper.

Business logic belongs in `src/schema/` (validate/run) or `src/observe/`
(observe); command handlers should only parse arguments, read files, call
those modules, and format output.

`index.ts` only dispatches; `cliShared.ts`, `validateCommand.ts`, and
`runCommand.ts` own shared formatting and the validate/run command routes.
`recover.ts` is the thin public restart route for durable composed journals and
reconstructs its provider from the versioned bootstrap capsule.

`runArguments.ts` parses the complete run flag matrix before authority opens.
`runRoute.ts` resolves authored `spawnfile:` linkage and selects composed or
explicit local execution. `composedRunCommand.ts` is the single thin production
adapter into the generic composed supervisor; `composedRunCompletion.ts` owns
seal/replay/final-receipt handling. `composedRunBootstrap.ts` binds a fixture
declaration to public Spawnfile CLI receipts without owning private target
configuration. The `composedBootstrap*` modules own the durable pre-target
capsule, reconstruction, and one-way execution binding.
`compiledOrganizationIdentity.ts` keeps Spawnfile's short
compile fingerprint distinct from the domain-separated composed artifact digest.
`composedProjectPreflight.ts` isolates trusted local binding/source checks and
detects ordinary bootstrap-time source drift.
`composedPreflightReport.ts` writes the preflight Spawnfile compile report once
as a mode-0600 fsynced authority snapshot and verifies its capsule-bound digest
for recovery; the mutable compiled report may be rewritten by `spawnfile up`
and is never a recovery identity source.
`credentialBindingProjection.ts` projects logical credential aliases consistently
across provisioning, world-member references, and private target mount names.
`composedRunArtifacts.ts` reconciles exported owner
evidence into the atomic composed run record before sealing.
`composedViewerBinding.ts` corroborates the host-only viewer data mapping
against trusted project extension ids before reserving the record.

Changed production files stay at or below 200 lines.
