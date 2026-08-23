---
title: Quickstart
description: Validate, run, observe, and replay a Simfile with the commands that ship today.
---

For the current source release, use the checkout's own built CLI with Node.js
>=22.19.0:

```bash
git clone https://github.com/noopolis/simfile.git
cd simfile
npm ci
npm run build
npm run example:local
```

The alias runs the canonical checked-in example with a unique run ID/output
and prints that directory. The examples below use `simfile` for readability.
In a source checkout, replace it with `node dist/cli/index.js`; do not rely on
an older global package with the same version string.

Simfile has two run paths: a bounded local mechanics run, and linked
composition. Local mode is the working zero-service diagnostic. Linked
composition has a separate source-development setup and a machine-readable
readiness verdict; manual target environment variables are not a substitute
for that setup.

## 1. Write and validate a world

The smallest valid `Simfile` is:

```yaml
simfile_version: "0.1"
name: tiny-world

clock:
  seed: run-001
  tick: 30s
```

Validation takes an explicit file path:

```bash
simfile validate ./Simfile
```

If the world names Spawnfile agents, teams, or rooms, pass a machine-readable Spawnfile report to check those bindings too:

```bash
simfile validate ./Simfile --spawnfile-report .spawn/spawnfile-report.json
```

`--spawnfile-report` accepts either a path or inline JSON. In local mode it supplies binding checks; linked composition uses the authored `spawnfile:` reference.

## 2. Run the deterministic kernel

`--local --ticks` is required. This command runs 144 ticks without sleeping and writes a sealed world run record:

```bash
simfile run ./Simfile --local \
  --ticks 144 \
  --run-id tiny-001 \
  --out runs/tiny-001
```

The directory contains `manifest.yaml`, `ledger.jsonl`, `report.json`, `telemetry.json`, and `viewer-trace.json`. Open it with:

```bash
simfile view runs/tiny-001
```

This is the correct path for testing clocks, variables, generators, rules, markers, probes, and optional local diagnostic inputs. It does not start an organization.

## 3. Compose a Spawnfile organization

For contributor work, install a separately checked-out Spawnfile into
Simfile's ignored tool root. The checkout can live anywhere:

```bash
npm run dev:spawnfile:setup -- --source /absolute/path/to/spawnfile
npm run dev:spawnfile:check
```

This copies that exact checkout into a private stage, builds and packs only the
stage, installs it under `.simfile-dev/`, and validates the standalone
`examples/jungian-dialogue/org/Spawnfile` project through the isolated
Spawnfile CLI. It never imports a sibling repository or resolves a global
command. Once a compatible release is published, the equivalent setup is:

```bash
npm run dev:spawnfile:setup -- --package spawnfile@<exact-version>
```

For a prepacked release, use `--artifact /absolute/release.tgz --sha256
<lowercase-sha256>` to pin the physical tarball without registry resolution.

The check records Simfile's `simfile.spawnfile-public-capability-probe.v1`,
using only generic documented Spawnfile CLI surfaces: `--version`,
`capabilities --json` when available, and legacy help only as a fail-closed
fallback. It never calls `spawnfile compatibility --profile simfile.*`. Run a
linked project only when its composed result is ready; otherwise its blockers
are authoritative. This prevents a partially configured run from creating
Docker or support state and later failing during evidence export.

After the composed probe reports ready, run the bounded Jungian dialogue with
one explicit local Docker context:

```bash
npm run example:composed -- --context <local-docker-context>
```

The alias creates a unique run/output with `--mode lifecycle-replay-smoke`,
pins the exact installed Spawnfile 0.1.17 public contract, and proves the
explicit context is a local endpoint before starting the lifecycle. The
distinct `simfile.composed-lifecycle-replay-smoke-receipt.v1` requires the
lifecycle and exact replay to pass while live agent-action evidence is
explicitly `not_evaluated`. An analyst observes a three-symbol dream through
its authenticated world binding; then analyst and daimon produce a finite
five-message scripted dialogue through their real Moltnet room. The viewer
labels it as an authored screenplay and opens on Conversation because the
sealed run contains participant speech.
Older, remote, default-selected, or contract-drifted Spawnfile installations
fail closed before lifecycle mutation.

Linked composition uses `simfile run <linked Simfile>` with no `--ticks` or
`--spawnfile-report`. The project also needs a checked-in `world_sidecar`
binding and composer.

There is no `simfile compose` command. The linked `simfile run <Simfile>` supervisor composes the lifecycle
around these authority boundaries:

```text
spawnfile up <org> --detach --name <container> --deployment <name> --out <compiled> --json
→ Simfile world supervisor + independent action ingress
→ spawnfile artifacts export <org> --deployment <name> --compiled <compiled> --out <run-dir> --json
→ spawnfile down <org> --deployment <name> --compiled <compiled> --json
→ manifest.json written last
```

The result is a `simfile.run-manifest.v1` directory with `raw/**/causal.jsonl`, Moltnet transcripts, memory artifacts, world telemetry where present, and SHA-256 entries for sealed artifacts. See [Spawnfile integration](/guides/spawnfile-integration/) for the boundary and [Memetics experiment](/guides/memetics/) for the shipped fixture.

## 4. Observe the composed run

Run the observer after linked composition has sealed the run directory:

```bash
simfile observe runs/<run-id>
```

It writes:

```text
runs/<run-id>/observe/report.json
```

That report contains participants, causally ordered agent turns, complete and incomplete chain counts, per-bank memory measurements, and failures. When the manifest declares a seed, it also contains `seed_spread` plus `spread_summary`.

To inspect the committed scripted golden run without starting any services:

```bash
simfile observe fixtures/observe/office-secret-v0-golden
```

The golden run is useful for learning the artifact and report shape. Its engine is `scripted`; it is not one of the five real-engine result runs.

## 5. Scrub the run

```bash
simfile view runs/<run-id>
```

A composed run is detected from its `simfile.run-manifest.v1`
`manifest.json`; a Moltnet transcript is optional. Add `--no-open` for a remote
shell or choose a port explicitly:

```bash
simfile view runs/<run-id> --port 4400 --no-open
```

For the separate snapshot-style live console, point at a state directory containing `viewer-trace.json`:

```bash
simfile view --state .sim --port 4400
```

The current live surface reads that trace snapshot and shows a synthetic looping tick heartbeat; it is not yet a tail of the ledger or Moltnet stream. The [viewer guide](/guides/viewer/) describes the exact behavior of each mode.
