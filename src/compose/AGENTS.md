# Composed Run Supervisor

This folder owns Simfile's generic, journaled sequencing of independent world
and Spawnfile lifecycle owners. It never selects an agent, schedules or wakes a
participant, invokes a model, opens Moltnet traffic, polls agent results, or
waits for cognition. The world clock is released by topology activation and is
never coupled to agent actions.

## Files

- `types.ts` — phase order and provider-neutral supervisor port types.
- `json.ts` — bounded ordinary-JSON, canonical hashing, and secret-shape checks.
- `contracts.ts` — shared strict identifiers and digested receipt helpers.
- `phase.ts` — durable phase commit, lookup, and resume helpers.
- `preflight.ts` — new-run rejection of local or scripted decision inputs before lifecycle authority opens.
- `request.ts` — strict `simfile.composed-run-request.v1` parser and digest.
- `execution.ts` — durable nonsecret provider inputs and exact recovery configuration.
- `projectBinding.ts` — host-only fixture declaration seam for a runnable world,
  credentials, evidence mappings, and mechanics-only replay adapter.
- `receipt.ts` — strict terminal and recovery receipt parsers/builders.
- `journal.ts` — monotonic phase journal, exact restore, and durable atomic store.
- `journalSession.ts` — pinned file identity, safe open, and expected-prior atomic replacement.
- `startup-world.ts` — prepared-resource to paused world-only readiness sequence.
- `startup-organization.ts` — organization-second startup and exact binding/readiness proof.
- `activation.ts` — topology attestation and single-use clock release.
- `supervision.ts` — world/service-only tick and terminal supervision.
- `finalize-world.ts` — pause/flush/hash/export of world evidence before cleanup.
- `finalize-organization.ts` — public Spawnfile artifact export and reconciliation.
- `cleanup.ts` — evidence-gated, receipt-owned teardown and revocation.
- `recovery.ts` — signal-safe interruption, durable recovery receipts, and resume.
- `run.ts` — the one high-level operation that composes these phase functions.
- `runRecord.ts` — the generic role-complete, exact-hash staging inventory and
  atomic live-to-sealed run-directory promotion; related artifact groups are
  adopted only after every member is durable.
- `replay.ts` — offline exact checkpoint/action-boundary replay through an
  injected mechanics-only adapter; it has no live service or process ports.
- `liveEvidence.ts` — post-seal per-principal authenticated strategic-action
  counts; these never feed mechanics, supervision, or cleanup.
- `commandReceipt.ts` — the one truthful stdout receipt derived from correlated
  lifecycle, capability, Moltnet, seal, cleanup, and post-hoc evidence proofs.
- `viewer.ts` — optional observer-only live-to-sealed viewer attachment; all
  extension/server failures remain outside lifecycle and mechanics authority,
  and a bounded observer wait acknowledges seal reconciliation before close.
- `viewerBinding.ts` — optional host-only mapping from trusted viewer-extension
  ids to recorded presentation artifacts and one bounded public live trace.
- `liveViewerProjection.ts` — observer-only mirroring of verified public trace
  bytes into the live frame transport; failed publications roll back, while
  exact snapshots plus canonical request/response evidence are sealed with the
  derived frame track and provenance ledger as one artifact group.
- `index.ts` — named public barrel.

Tests remain beside the boundary they prove. Production files stay below 400
lines. All journal and receipt values are secret-free, versioned, correlated to
one run, and additive only through a new versioned contract.

`lifecycle.test-helper.ts` supplies only neutral, secret-free lifecycle fixtures
for the colocated phase and end-to-end tests; it is excluded from production.
`run.test-helper.ts` supplies the isolated zero-agent target used by composed-run
and recovery integration tests; it is likewise excluded from production.
