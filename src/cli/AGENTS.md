# Simfile CLI

This folder contains the thin command-line wrapper.

Business logic belongs in `src/schema/` (validate/run) or `src/observe/`
(observe); command handlers should only parse arguments, read files, call
those modules, and format output.

`recover.ts` is the thin public restart route for durable composed journals.

`runArguments.ts` parses the complete run flag matrix before authority opens.
`runRoute.ts` resolves authored `spawnfile:` linkage and selects composed or
explicit local execution. `composedRunCommand.ts` is the single thin production
adapter into the generic composed supervisor. `composedRunBootstrap.ts` binds a
fixture declaration to public Spawnfile CLI receipts without owning private
target configuration. `compiledOrganizationIdentity.ts` keeps Spawnfile's short
compile fingerprint distinct from the domain-separated composed artifact digest.
`credentialBindingProjection.ts` projects logical credential aliases consistently
across provisioning, world-member references, and private target mount names.
`composedRunArtifacts.ts` reconciles exported owner
evidence into the atomic composed run record before sealing.
`composedViewerBinding.ts` corroborates the host-only viewer data mapping
against trusted project extension ids before reserving the record.
