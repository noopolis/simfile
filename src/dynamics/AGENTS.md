# Dynamics Provider Boundary

This folder owns the trusted local-module mechanics seam. It is generic: sport,
physics, economic, and other domain behavior belongs in project provider files,
not in Simfile schema keys.

## Files

- `types.ts` defines the public provider, action, observation, event, provenance,
  provider integration metadata, and provider-local snapshot contracts.
- `limits.ts` publishes the fixed v1 resource ceilings enforced at the boundary.
- `buildInput.ts` publishes the frozen, host-owned B11 TypeScript and esbuild
  preparation contract; B12 consumes it to prepare `.ts` and `.mjs` providers.
- `buildStaticPolicy.ts` publishes B54 static path, source, metafile, and output policy checks.
- `buildStaticCommonJsPolicy.ts` publishes the structural CommonJS detector used by emitted ESM policy checks.
- `buildStaticResolverPolicy.ts` publishes static source, separate runtime/declaration
  package resolution, and emitted resolver AST helpers.
- `buildPackagePolicy.ts` owns package identity plus the declaration-to-runtime
  ownership mapping used to avoid typechecking bundled vendor JavaScript when
  authoritative declarations exist.
- `buildSourceSnapshot.ts` retains first-observed preparation bytes so compiler,
  bundler, and closure hashing cannot silently consume different file contents.
- `buildRuntimeTypes.test.ts` proves runtime package bytes and separate
  declaration-package evidence are both sealed.
- `buildStaticCompilerHostPolicy.ts` publishes the lexical TypeScript resolution and compiler-read guard.
- `buildStaticGraphPolicy.ts` publishes immutable runtime-only graph preflight and exact metafile comparison.
- `buildStaticCompilerHostPolicy.test.ts` proves compiler lexical preflight/checked read invariants and delegate isolation.
- `buildStaticPolicy.test.ts` proves B54 static policy primitives without authored evaluation.
- `buildDeterminism.test.ts` proves complete closure/byte determinism under locale and isolated axis mutations.
- `buildHostile.test.ts` proves hostile and acceptance end-to-end boundaries without executing authored artifacts.
- `buildReceiptHostile.test.ts` publishes B13 hostile receipt boundary proofs for cross-root/locale stability, stale authority failures, ambiguity propagation, and hostile lock metadata omission.
- `buildReceiptCreation.test.ts` proves successful receipt construction and
  canonical closure evidence; `buildReceipt.test.ts` retains hostile receipt
  input and validation cases.
- `buildLoad.ts` owns the one-provider-per-run scratch lifecycle: verified
  content-address publication, receipt/source revalidation, artifact-only
  import, evidence handoff, and teardown cleanup.
- `buildLoadFiles.ts` owns no-clobber filesystem publication and exact
  per-path cleanup ownership for scratch and evidence pairs.
- `canonicalJson.ts` normalizes and canonically serializes bounded safe JSON.
- `load.ts` loads an explicitly declared provider and binds configuration,
  clock, seed, and provenance into a checked `DynamicsSession`.
- `loadCore.ts` owns the shared sealed provider/source build lifecycle;
  `loadRunActionSource.ts` is the internal run-driver loader for the optional
  named `createDynamicsRunActionSource` export.
- `runActionSource.ts` defines the genre-neutral, type-only public contract for
  a scripted/non-live tick notification source from the same sealed artifact.
- `modulePath.ts` resolves only regular, non-symlink, portable project-relative
  `.ts` or `.mjs` entry points and hashes their bytes.
- `session.ts` owns canonical action ordering, principal-scoped idempotency,
  fixed synchronous stepping, immutable integration metadata, exact sense
  grants, rollback, and snapshot state.
- `sessionContract.ts`, `sessionIssuance.ts`, and `sessionProviderBoundary.ts`
  keep the public facade, unforgeable authority issuance, and synchronous
  provider rollback checks separate from session state transitions.
- `retainedCapacity.ts` owns the issued, exact error identity for permanent
  retained action-ingress capacity frontiers.
- `sameDynamicsSessionSnapshot.ts` compares already issued session snapshots
  for world purity checks without the generic hostile-JSON ceiling.
- `validation.ts` checks provider metadata, output, and public wire values.
- `snapshotValidation.ts` validates provider-local checkpoint invariants.
- `testSupport.test-helper.ts` is test fixture support excluded from production emit.
- `index.ts` is the public barrel.

## Constraints

- Prepared providers are trusted bundled Node code, not sandboxed plugins.
  Build path and closure checks prevent accidental source escape; they do not
  restrict allowlisted built-ins, environment access, networking, or clocks.
- Effective seed, clock scaling, and canonical config are validated before the
  host resolves or evaluates provider code; invalid initialization fails closed.
- `module_sha256` covers the exact executed bundle. A loader nonce re-evaluates
  that content-addressed artifact for every session; the prepared bundle seals
  project and package code while allowlisted `node:` built-ins remain runtime
  externals.
- B11 defines only the authored entry-path and fixed build-input contract. B12
  owns in-memory preparation; B14 owns artifact persistence and verified loading.
  Do not add bundling or typecheck execution to `buildInput.ts`.
- B13 owns hostile proof coverage for post-prepare authority failures, receipt
  stability, ambiguity propagation, and hostile lock-metadata omission.
- Only the host assigns action/event order, tick, identity, and mechanical
  provenance. Providers decide mechanics but cannot replace host-stamped fields.
- A run action source receives canonical frozen initialization and a
  tick-scoped host port only. It must never receive the provider, session,
  filesystem, transport, credentials, clocks, models, or fixture-specific
  vocabulary through this generic contract.
- `queueAction` changes host ingress state only. Provider state may change only
  inside synchronous `step`, `initialize`, or `restore`; `observe` and
  `snapshot` are pure contracts.
- Sense access is an exact host-resolved address grant. Providers never receive
  caller identity and cannot widen the supplied grant list.
- A `DynamicsSessionSnapshot` is not a whole-world checkpoint. A composed
  driver must also preserve Simfile variables, rule state, presence, ledger
  cursors, and any other subsystem state.
- All provider inputs and outputs are bounded by `DYNAMICS_LIMITS`; exceeding a
  depth, size, history, action, sense, event, or cause fuse fails closed. V1
  allows 24 JSON levels, 4,096 nodes, 16,384 UTF-16 code units per string,
  65,536 cumulative key/string code units per JSON value, 256 per identifier,
  4,096 per result message, 10,000 retained ingress records, and 1,048,576
  canonical serialized code units across retained ingress. The exported limits
  object is normative for the remaining per-tick and observation ceilings.
- Keep schema and runtime genre-neutral, files below 400 lines, named exports,
  and tests beside the code they cover.

## Action retention policy

Action evidence has three retention tiers:

1. Durable evidence keeps every complete attempt, receipt, result, and causal
   event. The run writer streams these values to `raw/action-attempts.jsonl`,
   `raw/action-results.jsonl`, `raw/world/causal.jsonl`, and the canonical
   ledger. Each append is synchronized before the session acknowledges that
   attempt. These artifacts are the source for evidence and replay.
2. Live host state keeps complete inputs only in the current tick's pending
   queue. Its idempotency index keeps `principal_id`, `act_id`, `at_tick`, the
   issued receipt, and a 64-code-unit SHA-256 digest of the canonical attempt.
   Accepted and resolved sequence sets use a contiguous floor plus bounded
   entries above that floor. Complete evidence awaiting a durable
   acknowledgment is bounded to the same one-tick admission frontier and is
   not checkpoint state.
3. After durable acknowledgment, a complete input that is no longer pending
   is released. Idempotency entries are released when `step()` advances beyond
   their admission tick. The complete value remains in the durable artifacts
   named above.

The necessary idempotency window is one host tick, with no additional retry
grace. `queueAction` can queue an attempt only when `at_tick === nextTick`.
After `step()` advances, that same attempt can only receive `wrong_tick`, so an
older queued receipt would no longer be a truthful current answer. A retry
after eviction therefore receives a new `wrong_tick` receipt instead of the
earlier queued receipt.

The new-identity bound for that window is
`DYNAMICS_LIMITS.actions_per_tick`, and it applies to queued identities and
temporal rejections alike. This explicitly caps the previously uncapped
rejection path. The canonical compact-record maximum is derived in
`limits.ts`: an identifier can occupy `2 + 256 * 6 = 1,538` serialized code
units after JSON escaping, a digest occupies `2 + 64 = 66`, and a safe integer
occupies at most 16. The larger queued receipt shape is
`129 + 3 * (1,538 - 2) + (66 - 2) + 3 * (16 - 1) = 4,846` code units. Therefore
the ingress ceiling is `128 * 4,846 = 620,288` code units. The established
`retained_action_records` and `retained_action_code_units` values remain
unchanged as hostile-input backstops for other host stores.

For a probe with 200 concurrent submitters producing large structured attempts
each tick, only 128 can enter the contract window. The 129th submission raises
the issued retained-capacity error and the run fails closed; later submissions
are not silently discarded. Complete pending inputs remain subject to the
existing per-value JSON bounds, while compact retained cost is independent of
their size.

For a probe with two submitters acting only once every few thousand ticks, the
index is empty between active ticks. Both entries remain available throughout
their admission tick and are released after advancement. The bound is chosen
in records rather than elapsed ticks, so sparse submissions receive the same
truthful current-tick retry behavior without reserving history during silence.

Persistent stream volume is unchanged and continues to grow with durable
evidence; this policy bounds live host retention only.
