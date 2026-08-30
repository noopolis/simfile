# Composed development lifecycle/replay smoke

This is a standalone source-checkout example for the linked Simfile +
Spawnfile development path. It contains one deterministic scripted agent, no
Moltnet surface, a world provider, a public project binding, an emitted-surface
composer, finite world control, evidence mappings, and an exact replay adapter.

The contract test consumes this exact example and prepares the runnable sidecar bundle without
Docker. It verifies paused readiness, the one principal/capability binding,
the complete evidence mapping, and exact mechanics replay to the fixed
terminal tick.

This example is deliberately a **lifecycle/replay smoke**. The scripted engine
has no authenticated world ingress, so live agent action is **not evaluated**.
The example records an empty accepted-action stream and never invents an agent
action. Run it from a Simfile source checkout only after
`dev:spawnfile:check` reports Simfile's
`simfile.spawnfile-public-capability-probe.v1` as composed-ready:

```bash
npm run example:composed -- --context <local-docker-context>
```

The runner uses the explicit `--mode lifecycle-replay-smoke` command mode plus
a unique run ID and output. It pins the exact installed Spawnfile 0.1.17 public
contract and proves that the requested context is a local endpoint before
starting the lifecycle. `simfile.composed-lifecycle-replay-smoke-receipt.v1`
proves the lifecycle and exact replay only, reports live agent-action
evidence as `not_evaluated`, and carry no live simulation verdict. A normal
linked run without that mode still requires an authenticated, applied action
from every principal and will not treat this example's empty stream as success.

The probe uses only generic documented Spawnfile CLI surfaces. It prefers
`spawnfile capabilities --json`, validates its complete generic lifecycle
contract set, and falls back to help only to explain an older release. It never
calls `spawnfile compatibility --profile simfile.*`. Older, remote,
default-selected, or contract-drifted installations stop before lifecycle
mutation.

## Project map

```text
Simfile                 # clock, seed, linked organization, and terminal tick
binding.mjs             # public composed-project binding
binding-world.mjs       # deterministic kernel, replay adapter, and evidence map
org/                    # minimal scripted Spawnfile organization
world/composer.mjs      # deterministic sidecar bundle authoring
world/provider.mjs      # finite controller and evidence emission
world/evidence.mjs      # evidence/replay mapping
world/surface.mjs       # public world surface declaration
harness/scripted-engine.mjs # credential-free scripted organization engine
```

## Modes and outputs

`npm run example:local` is the runnable, mechanics-only path. It invokes the
built CLI with `--local --ticks 4` and allocates a unique
`runs/example-local-<uuid>` directory. Inspect it with:

```bash
node dist/cli/index.js view runs/example-local-<uuid>
```

`npm run example:composed -- --context <local-docker-context>` runs the linked
`--mode lifecycle-replay-smoke` invocation with its own unique run ID and
output after local-endpoint proof. The sealed output contains the world and
organization evidence, terminal
signal, and replay proof; the smoke receipt will still say
`live_action_evidence: not_evaluated`.

For recovery, retain the printed `simfile recover --journal ...` command if a
lifecycle reports one. Do not delete its private support root
or attempt manual target cleanup: Spawnfile owns target and credential
resources. To convert this example to a real engine, replace the scripted
member in `org/` with an explicitly profiled engine, preserve the declared
world bindings, and use normal linked `simfile run` mode; every required
principal must then contribute an authenticated accepted action.
