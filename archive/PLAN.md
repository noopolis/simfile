# Simfile Standalone Composed Example Plan

This plan changes Simfile only. Spawnfile is an immutable external CLI owned by
the user's separate Spawnfile thread. Do not modify Spawnfile or depend on any
current uncommitted Spawnfile changes.

## Status legend

- **done** — implemented and verified within the authority of this repository.
- **implemented-awaiting-compatible-acceptance** — implemented and covered by
  local/contract tests, but the real compatible external flow is not yet
  accepted.
- **open** — actionable Simfile work remains.
- **external-blocked** — completion requires a released, consumer-neutral
  Spawnfile contract or an explicitly selected local external environment.

## Current landing gate

The composed wrapper intentionally fails its read-only preflight against the
immutable installed Spawnfile 0.1.14. That release does not expose the generic,
machine-verifiable resolver, evidence-export, and typed terminal-pending
capabilities Simfile requires. Local tests being green does **not** equal a
successful external composed acceptance.

A reviewed but **unreleased** generic Spawnfile draft is also not an
acceptance candidate: its local evidence-helper path requires an OCI
`RepoDigest` that a classic local Docker build may not have, and it has no
durable mutation-recovery authority. Its image-mode `up` receipt is likewise
not sufficient to reconstruct the composed lifecycle on recovery. Simfile must
not parse, pin, or execute that draft through a sibling/source checkout.

The independent boundary review additionally found that the draft retains
caller-managed helper-authority paths, has a race in public-artifact reads,
does not enumerate a complete lifecycle contract set, and cannot support a
fresh-process Simfile provider reconstruction. All are external P1 release
blockers. A compatible artifact must be version-bumped; it must never reuse
the already-installed `0.1.14` identity.

The former manual target environment/helper ABI has been removed from the
composed product path. Simfile now has a consumer-neutral, journal-aware
internal target-provider seam whose default fails closed until an exact
released public contract can be adapted. Consequently no target preparation,
credential provisioning, staging, or support-root creation can occur after
preflight today. Do not make the probe return ready, land the composed path,
or claim it runnable until generic external resolution is wired behind that
seam with journal authority established before its first mutation.

Landing is also premature while the feature remains a dirty/untracked delivery
set. Every feature file must be accounted for, the branch must safely include
upstream, and the full validation and acceptance gates below must pass.

## 1. Protect the repository boundary

**Status: done (boundary), external-blocked (generic coordination).**

- [x] Make changes only inside `simfile/` from this workstream.
- [x] Treat Spawnfile as an external immutable CLI.
- [x] Do not add Simfile examples, profiles, receipt names, or dependencies to
  Spawnfile.
- [x] Do not depend on experimental uncommitted Spawnfile changes.
- [ ] Give the Spawnfile thread only a generic capability checklist; final
  compatible contract identity remains external-blocked.

## 2. Organize Simfile examples and fixtures

**Status: open.** The canonical example exists and is contract-tested; the
fixture inventory still needs an item-by-item purpose audit. Do not broadly
relocate e2e or test-contract fixtures.

- [x] Create top-level `examples/` for user-runnable projects.
- [ ] Keep `fixtures/` only for malformed inputs, edge cases, golden outputs,
  and isolated contracts; audit each existing fixture by actual purpose before
  moving or deleting it.
- [x] Canonicalize the actual checked-in tree:

  ```text
  examples/composed-development/
  ├── AGENTS.md
  ├── CLAUDE.md -> AGENTS.md
  ├── README.md
  ├── Simfile
  ├── binding.mjs
  ├── harness/
  │   ├── AGENTS.md
  │   ├── CLAUDE.md -> AGENTS.md
  │   └── scripted-engine.mjs
  ├── org/
  │   ├── AGENTS.md
  │   ├── CLAUDE.md -> AGENTS.md
  │   ├── Spawnfile
  │   ├── TEAM.md
  │   └── agents/smoke/
  │       ├── AGENTS.md
  │       ├── CLAUDE.md -> AGENTS.md
  │       └── Spawnfile
  └── world/
      ├── AGENTS.md
      ├── CLAUDE.md -> AGENTS.md
      ├── composer.mjs
      ├── evidence.mjs
      ├── provider.mjs
      └── surface.mjs
  ```

- [x] Make tests consume the exact example rather than a copy.
- [ ] Give each example one distinct workflow; remove or merge only when a
  duplicate purpose is proven by the fixture audit.
- [x] Use project-relative paths only; reject absolute, sibling, user, private
  host, GPU, and private-auth assumptions.

## 3. Build a complete composed Simfile project

**Status: implemented-awaiting-compatible-acceptance.**

- [x] Make the root Simfile declare its clock and seed, project-local
  organization Spawnfile, binding and composer, and finite terminal tick.
- [x] Export `composedProjectBinding` from `binding.mjs`.
- [x] Import only published Simfile exports; never import `simfile/src` or
  Spawnfile internals.
- [x] Build a deterministic, independently verifiable world artifact.
- [x] Declare members, principals, grants, readiness, replay, and evidence
  mappings.

## 4. Produce complete world evidence

**Status: implemented-awaiting-compatible-acceptance.** The exact checked-in
example controller contract test is complete without Docker.

- [x] Write initial and terminal checkpoints, accepted-action ledger, result
  ledger, principal projection, probe, replay expectation, and terminal signal.
- [x] Publish the terminal signal atomically at the terminal tick.
- [x] Use one public Simfile terminal path and contract constant.
- [x] Make replay restore initial state, apply recorded inputs, and reproduce
  terminal state.
- [x] Never fabricate agent actions.
- [x] Execute the emitted controller in the exact-example contract test and
  verify evidence, terminal checkpoint, terminal signal, and replay mapping.

## 5. Add honest development-smoke semantics

**Status: implemented-awaiting-compatible-acceptance; command execution is
external-blocked.** The canonical explicit syntax is:

```bash
simfile run ./examples/composed-development/Simfile \
  --mode lifecycle-replay-smoke
```

- [x] Canonicalize `--mode lifecycle-replay-smoke`; do not introduce a second
  `--smoke` spelling.
- [x] Leave existing strict live behavior unchanged; keep the cross-repo
  Spawnfile request within a generic supported mode.
- [x] Keep smoke mode only in Simfile local execution and its separate,
  versioned receipt.
- [ ] Make the real external smoke prove validation and compile, artifact,
  lifecycle, readiness, terminal, evidence export, cleanup, sealing, and
  deterministic replay.
- [x] Report live agent-action evidence as `not_evaluated`; never present smoke
  as live-action success.
- [x] Require authenticated accepted actions for every required principal in
  normal live mode.
- [x] Unit/contract evidence proves the smoke action stream is empty and the
  smoke receipt says `not_evaluated`, while strict live remains strict.

## 6. Make scripted development credential-free

**Status: implemented-awaiting-compatible-acceptance.** Scripted auth
classification is locally tested; real external execution remains blocked.

- [x] Inspect compiled engines.
- [x] For an all-scripted organization, use no auth profile, model credential
  request, credential-store read, or Spawnfile auth flag.
- [x] When Codex is present, require an explicit profile and use the supported
  Codex request.
- [x] For another non-scripted engine, require an explicit Spawnfile profile
  but never falsely label it as Codex.

## 7. Add standalone Spawnfile installation for Simfile development

**Status: implemented-awaiting-compatible-acceptance.** Isolated package/source
setup and full installed dependency-closure attestation work locally; a
fresh-clone exercise remains open.

- [x] Support exact package installation:

  ```bash
  npm run dev:spawnfile:setup -- --package spawnfile@<exact-version>
  ```

- [x] Also support an explicit, physical, absolute source checkout that is
  verified, copied to a private stage, packed with `npm pack`, and installed in
  isolation without mutating the source checkout.
- [x] Never infer `../spawnfile`, use a `file:` sibling dependency, silently use
  a global installation, execute source directly, or import Spawnfile.
- [x] Record binary, version, origin, tarball digest, executable digest, and
  probe identity in ignored private state, and reverify them.
- [x] Attest the installed Spawnfile module/dependency closure, not only the
  unchanged CLI entrypoint and saved tarball.

## 8. Implement a Simfile-owned compatibility preflight

**Status: implemented-awaiting-compatible-acceptance and external-blocked.**
Spawnfile 0.1.14 correctly reports not ready and Simfile stops before mutation.

- [x] Use no Spawnfile `simfile.*` profile.
- [x] Probe only generic documented Spawnfile surfaces and emit a Simfile-owned
  report.
- [x] Prefer `spawnfile capabilities --json` when available; strictly parse
  `spawnfile.capabilities.v1`, the complete
  `spawnfile.composed-lifecycle-contract-set.v1`, and all 43 declared command
  rows before considering any future adapter. Fall back to legacy help only to
  explain why Spawnfile 0.1.14 is unverified.
- [ ] Check executable and version, validate and compile, generic target
  resolver and config receipt, evidence export, terminal snapshot and typed
  pending, optional model auth, and prepared-plan contract through exact
  released contract identities.
- [x] Run the current fail-closed preflight before state, image pulls, remote
  contact, credentials, or containers.
- [x] Report exact blockers and perform zero mutation on failure.
- [x] Exercise the built linked CLI against the isolated exact
  `spawnfile@0.1.14` artifact: its missing generic capability command produces
  explicit blockers and creates neither an output directory nor support state.
- [ ] Obtain consumer-neutral generic capability discovery covering evidence
  export and typed terminal pending from an exact compatible Spawnfile release.
- [ ] Require a pinned released `spawnfile capabilities --json` identity before
  adapting any future capability report. Parsed discovery deliberately remains
  `simfile_target_provider_not_admitted` until an independently installable,
  pinned artifact can bind its opaque target provider state to the durable
  journal.

## 9. Keep Docker and target ownership in Spawnfile

**Status: implemented-awaiting-compatible-acceptance (seam), external-blocked
(provider).**

- [x] Ensure Simfile never directly inspects Docker or implements deployment.
- [ ] Let only the external Spawnfile CLI resolve configuration, provision
  target/evidence helpers, deploy, and revoke its owned resources.
- [ ] Auto-select only the current local context; require an explicit choice
  for a remote target.
- [ ] Require the generic response to supply context, classification,
  architecture, base reference, config digest, strict config, and evidence
  authority under exact released contract identities.
- [x] Remove the manual target environment/helper ABI from the implementation,
  not merely from documentation. The composed execution schema and production
  target driver contain no helper executable, target-config bytes, or
  legacy target-helper environment path.
- [ ] Verify working image-mode `up --json` only if the actual admitted Simfile
  invocation requires it.
- [ ] Reject a future image-mode receipt unless it has enough versioned,
  journal-reconstructible lifecycle and cleanup authority for recovery; the
  reviewed draft `spawnfile.image-up-receipt.v1` does not yet meet that bar.

## 10. Make bootstrap failures recoverable

**Status: implemented-awaiting-compatible-acceptance.** The current
incompatible preflight is safe and the removed adapter can perform no mutation
after it. The future released provider integration remains gated on creating
the durable journal before its first target/auth mutation.

- [x] Perform read-only validation and compile before mutation where possible.
- [x] Create an exclusive private support root.
- [x] On a pre-journal failure, revoke every created credential and delete only
  the exact run-owned support root without poisoning retry.
- [x] Remove the pre-journal target/auth mutation path. The default target
  provider fails before any support root, target preparation, staging, or
  credential operation; its recovery test preserves a durable journal.
- [ ] When the released provider is integrated, journal before its first
  target/auth mutation, preserve the journal on failure or interruption, and
  print the exact recovery command.
- [ ] Ensure Spawnfile alone provisions and revokes target/auth resources;
  Simfile records only public handles/receipts needed for recovery.
- [x] Prove that current record/journal admission cannot leak target
  preparation, credentials, staging, or the exclusive support root: no such
  operation is reachable before the provider seam is admitted.
- [x] Keep `simfile recover` fail-closed before constructing production ports
  when no provider is admitted; it verifies and preserves the durable journal
  byte-for-byte rather than replaying an old journal through legacy lifecycle
  commands.

## 11. Bound terminal polling

**Status: done for the composed terminal path.**

- [x] Retry only the exact typed not-present condition.
- [x] Treat malformed, correlation, target, container, and schema errors as
  permanent.
- [x] Use an explicit timeout, abort the underlying operation, await
  quiescence, and retain no timers or background loop.
- [x] Bound the uncooperative-port quiescence failure itself.

## 12. Add convenient source-development commands

**Status: open.** Aliases and unique planned IDs/outputs are implemented in the
working tree, but final validation and a real compatible composed invocation
remain open.

- [x] Add these commands:

  ```text
  example:local
  dev:spawnfile:setup
  dev:spawnfile:check
  example:composed
  ```

- [x] Make `example:local` invoke the built CLI and canonical example with a
  unique default run ID and output path.
- [x] Make `example:composed` plan the built CLI, canonical example, explicit
  smoke mode, and unique default run ID/output while retaining fail-closed
  preflight.
- [ ] After generic external integration, make `example:composed` actually
  invoke the built CLI rather than ending at the compatibility gate.
- [ ] Print the verified Spawnfile identity, selected local target, run
  directory, mode, viewer command, and recovery command when those authorities
  actually exist; never fabricate them on preflight failure.
- [x] Keep the direct CLI available.

## 13. Document the exact clean-clone path

**Status: implemented-awaiting-compatible-acceptance.** README, example, and
site wording now describe the aliases, unique outputs, preflight-only composed
state, recovery ownership, and strict/live smoke distinction. Fresh-clone and
compatible external acceptance remain required.

- [x] Put clone, `npm ci`, build, `example:local`, setup, and
  `example:composed` commands in the README.
- [x] Document Node.js >=22.19, local Docker for the future external acceptance,
  first-download network access, and that the scripted smoke needs no model
  credentials.
- [x] Make the example README own its complete file map, modes, output,
  replay/view, cleanup/recovery, and transition to a real engine.
- [x] Keep the website quickstart, CLI reference, and integration guide in
  agreement with the current preflight-only behavior; remove obsolete fixture
  and private-infrastructure claims.
- [ ] Run the documented flow from a genuinely fresh clean clone.

## 14. Test without duplicating the example

**Status: implemented-awaiting-compatible-acceptance, with external acceptance
gates open.**

- [x] Add unit tests for flags, receipt semantics, strict verdict, auth
  classification, discovery, compatibility, rollback helpers, cancellation,
  and the pending receipt.
- [x] Contract-test the exact checked-in example: schema, paths, binding,
  artifact, emitted controller, terminal, evidence, and replay.
- [x] Use fake Spawnfile processes to verify public CLI use, zero state on
  incompatible preflight, no model credentials for scripted mode, typed
  pending, cancellation, and executable identity.
- [x] Extend package closure to import and build the exact packed
  `examples/composed-development/binding.mjs` from a temporary external
  package root, not merely assert that its files are present.
- [ ] Keep real local-Docker acceptance opt-in and run it only after a
  compatible Spawnfile is installed; never select a remote target
  automatically.

## 15. Coordinate with the separate Spawnfile thread

**Status: external-blocked.**

- [ ] Send only this generic checklist: machine-readable consumer-neutral
  capabilities, safe resolver, evidence-export provisioning, typed terminal
  pending, optional model auth, and unique versioned contract identities.
- [x] Never modify Spawnfile here.
- [ ] Wait for an exact compatible artifact, pin it, and run clean-clone
  acceptance.
- [ ] Record the exact compatible Spawnfile version and contract IDs before
  enabling the composed adapter.
- [ ] Do not integrate the reviewed unreleased draft: its evidence-helper
  `RepoDigest` assumption and missing durable target/auth recovery are P1
  blockers, and no artifact newer than installed Spawnfile 0.1.14 is pinned.
- [ ] Await a version-bumped artifact only after the separate Spawnfile thread
  removes caller-managed helper authority, immutably binds the evidence-helper
  receipt to its accepted image-config digest, proves public-artifact reads are
  race-safe, publishes a complete and truthful lifecycle contract-set identity
  (including lookup, project-mode up/down/export, terminal, and credential
  semantics), and passes fresh-process provider recovery plus classic
  local-Docker acceptance. The current draft fails this gate and still reports
  the already-released `0.1.14` package identity.

## 16. Apply the review loop

**Status: open.** Terra implementation and independent Sol P0-P4 reviews have
run, but this plan deliberately retains the P1/P2 landing gates above.

- [x] Have subagents perform every implementation and test action.
- [x] Use bounded Terra implementation and independent Sol review using P0-P4.
- [ ] Before the next implementation phase, fix every P0, P1, and borderline
  P2; the pre-journal ownership P1 remains open.
- [ ] In the final repository-wide review, resolve relevant remaining P2+.
- [x] Scan portability for usernames, personal paths, private hosts, GPU
  labels, sibling imports, and stale ecosystem paths; the current scoped scan
  found no private-machine spillover.

## Validation and delivery gates

**Status: open.** Current local validation is green, but unaccounted delivery
state and external acceptance remain open.

- [x] The prior full repository run passed 1,670 tests with zero failures.
- [x] Focused composed tests (78 assertions), script tests (12 assertions),
  typecheck, site build, and the strengthened package-closure verifier passed
  on the current worktree.
- [x] Rerun focused/unit tests, typecheck, package-closure verification, and
  the site build on the current working tree.
- [x] The serial full-repository rerun for the current provider-seam
  refinement passed 1,670 tests with zero failures.
- [x] The canonical local source-checkout example completed with a unique run
  directory, and `simfile observe --json` verified its sealed artifact
  digests. The generated ignored run was then removed.
- [ ] Account for every dirty and untracked feature file; exclude unrelated
  user work from the delivery.
- [ ] Put the work on a safe branch that includes/reconciles current upstream
  without destructive reset or silent conflict loss.
- [x] Preserve the proof that smoke action evidence is empty/`not_evaluated`
  and strict live action evidence remains strict.
- [ ] Complete opt-in real local-only Docker acceptance using the exact pinned
  compatible Spawnfile release.
- [ ] Complete fresh clean-clone acceptance from the documented commands.

## Definition of done

**Status: open and external-blocked; do not mark complete from local tests.**

- [ ] A clean clone runs the local example immediately.
- [ ] The composed example is complete, self-contained, and invoked through
  the Simfile CLI only.
- [ ] Spawnfile is independently installed and consumed only through its
  generic public CLI.
- [x] The scripted smoke contract uses no model credentials and reports action
  evidence as empty/`not_evaluated`, while strict live remains strict.
- [x] An incompatible Spawnfile fails before mutation.
- [ ] A compatible Spawnfile completes lifecycle, evidence, cleanup, replay,
  and viewer flows in opt-in real local-only Docker acceptance.
- [x] No private-machine assumptions or Simfile-specific spillover enter
  Spawnfile.

## Out of scope / rejected review expansion

The following are separate tasks and must not be smuggled into this workstream:

- ecosystem-wide or all-repository edits;
- any Spawnfile implementation change from the Simfile thread;
- a broad receipt-first redesign of the entire CLI;
- broad fixture relocation without an item-by-item purpose audit.
