---
title: Quickstart
description: Validate, run, observe, and replay a Simfile with the commands that ship today.
---

Install Simfile with Node.js 22 or newer:

```bash
npm install --global simfile
simfile --help
```

Simfile has two run paths. `simfile run` executes the deterministic world kernel. A composed run also starts a Spawnfile organization and produces the cross-system artifact shape that `simfile observe` expects. The composed path is currently a repository API, not a public CLI subcommand.

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

`--spawnfile-report` accepts either a path or inline JSON. The top-level `spawnfile:` value is an authored source reference; the CLI does not parse that file or start it implicitly.

## 2. Run the deterministic kernel

`--ticks` is required. This command runs 144 ticks without sleeping and writes a sealed world run record:

```bash
simfile run ./Simfile \
  --ticks 144 \
  --run-id tiny-001 \
  --out runs/tiny-001
```

The directory contains `manifest.yaml`, `ledger.jsonl`, `report.json`, `telemetry.json`, and `viewer-trace.json`. Open it with:

```bash
simfile view runs/tiny-001
```

This is the correct path for testing clocks, variables, generators, rules, markers, probes, and queued world acts. It does **not** start the organization referenced by `spawnfile:`.

## 3. Compose a Spawnfile organization

Agent-backed experiments use the source drivers under `src/sims/`:

- `runWorldDrivenOfficeSim` starts a Spawnfile org, advances the same Simfile kernel one live tick at a time, sends world actions through Moltnet, exports artifacts, tears the org down, and writes `manifest.json` last.
- `runComposedOfficeSim` runs the simpler single-network composed office flow.
- `runComposedJungianSim` handles multi-network organizations whose agents contain interior teams.

These drivers are exported from `src/sims/index.ts` for repository dev/ops use. They are not exported from the npm package root, have no npm script, and are not a `simfile` CLI command. A driver shells this real lifecycle through Spawnfile:

```text
spawnfile up <org> --detach --name <container> --deployment <name> --out <compiled> --json
→ Simfile world loop over Moltnet
→ spawnfile artifacts export <org> --deployment <name> --compiled <compiled> --out <run-dir> --json
→ spawnfile down <org> --deployment <name> --compiled <compiled> --json
→ manifest.json written last
```

The result is a `simfile.run-manifest.v1` directory with `raw/**/causal.jsonl`, Moltnet transcripts, memory artifacts, world telemetry where present, and SHA-256 entries for sealed artifacts. See [Spawnfile integration](/guides/spawnfile-integration/) for the boundary and [Memetics experiment](/guides/memetics/) for the shipped fixture.

## 4. Observe the composed run

Run the observer only after the composed driver has sealed the run directory:

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

A composed run is detected from its `manifest.json` and Moltnet transcript and opens the full run-replay application. Add `--no-open` for a remote shell or choose a port explicitly:

```bash
simfile view runs/<run-id> --port 4400 --no-open
```

For the separate snapshot-style live console, point at a state directory containing `viewer-trace.json`:

```bash
simfile view --state .sim --port 4400
```

The current live surface reads that trace snapshot and shows a synthetic looping tick heartbeat; it is not yet a tail of the ledger or Moltnet stream. The [viewer guide](/guides/viewer/) describes the exact behavior of each mode.
