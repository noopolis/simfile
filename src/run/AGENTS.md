# Local Run Driver

This folder owns the local deterministic dispatch seam used by explicit local
diagnostics and backward-compatible unlinked `simfile run` execution. It is not
the linked-project lifecycle composer.

## Boundaries

- Follow `docs/DESIGN.md` and, when working in the parent Spawnfile repository,
  its `specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md`; that upstream specification is
  not included in a standalone Simfile checkout.
- Keep the trace path byte-compatible. Dispatch above `writeRunRecord`; do not
  change `runSimfileTrace` or the trace record writer.
- A sealed run action source is one scripted/non-live tick notification, not
  agent cognition or participant scheduling. Never await or retry it, iterate
  its participant declaration as a roster, or fabricate an action from silence.
- Never expose the raw dynamics session to an authored source or import a
  fixture controller. Scripted actions use the generic controller authority;
  independently submitted agent actions use `WorldRuntime.act()`. Both routes
  converge on the existing dynamics ingress queue.
- The dynamics path has no agent cognition, provider transport, action
  synthesis, polling, pacing, or retry.
- Do not add world-service or Spawnfile lifecycle operations here. A linked
  project is routed by the CLI to the separate generic lifecycle-composition
  layer, and any future `simfile dev` wrapper must reuse that layer.
- Do not compose trace mechanics with dynamics here. Mixed declarations fail
  closed until B158 defines whole-world checkpoints and interleaving.
- Derive all recorded timestamps from simulated time. Do not record scratch,
  staging, or resolved host paths.
- Keep run records honest: empty action inputs and results are present, and
  unresolved world grants are labeled explicitly.
- Use named exports, keep files below 400 lines, and keep tests beside the code
  they cover.

## Files added by B192 (motion track)

- `dynamics-run-artifacts.ts` — exports `dynamicsRunStagingPrefix`, the single
  owner of the staging-directory naming convention.

- `dynamics-run-frames.ts` — `createDynamicsRunFrameRecorder`: writes
  `raw/frames.jsonl`, the run's ONLY per-tick spatial artifact, projected from
  the provider's optional `spatial()` seam. Header line first (scene bounds +
  `sim_seconds_per_tick`), then one line per tick starting at tick 0. Both step
  loops call `capture()` after `step()`; miss the action-bearing one
  (`dynamics-run-action-ticks.ts`) and exactly the agent-driven matches lose
  their motion. Frames go straight to disk and never accumulate in memory.
  Action ingress is bounded to one tick and complete evidence is streamed and
  acknowledged only after durable append. Append-ordered, fsynced at the
  evidence-acknowledgement barrier and at seal, never rewritten, so a partially
  written run is a valid prefix that a reader may tail; readers must treat a
  torn final line as not-yet-written.
- `dynamics-run-contract-versions.ts` — the manifest's declared contract
  version set, extracted from `dynamics-run-record.ts` (behavior-preserving) to
  hold that file under 400 lines. New artifacts declare themselves here.
- `raw/world/action-refusals.jsonl` is the always-present, versioned world
  ingress-refusal artifact. The action-bearing tick loop drains its optional
  host-only refusal port after dynamics ingress evidence and before stepping,
  appends the matching causal event, then acknowledges the ordinal. It never
  widens the dynamics action-attempt contract or constructs a world runtime.

## Stage 2 viewer boundary

The viewer may enumerate staging directories and follow `raw/frames.jsonl`, but
the run production path remains deterministic and unchanged. `dynamicsRunStagingPrefix`
is the sole naming-convention helper; do not duplicate it or add viewer polling,
clocks, timers, or directory enumeration to production files in this folder.
