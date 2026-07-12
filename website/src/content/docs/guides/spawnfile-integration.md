---
title: Spawnfile Integration
description: How Simfile binds to, runs around, and observes a Spawnfile organization without absorbing it.
---

Spawnfile owns the organization. Simfile owns the deterministic world and the resulting measurement. Their integration is through versioned files, CLI receipts, and Moltnet—not imports of Spawnfile internals.

## Authoring reference versus resolved graph

A Simfile may point at the authored organization:

```yaml
spawnfile: ../org/Spawnfile
```

That string is a source reference for authors and orchestration. `simfile validate` and `simfile run` do not parse it and do not start the organization.

For binding validation, pass Spawnfile's machine-readable resolved graph explicitly:

```bash
simfile validate ./world/Simfile \
  --spawnfile-report .spawn/spawnfile-report.json
```

The same check can run before a finite kernel trace:

```bash
simfile run ./world/Simfile \
  --ticks 144 \
  --out runs/world-check \
  --spawnfile-report .spawn/spawnfile-report.json
```

The report lets Simfile verify referenced agents, teams, and rooms in variable and marker scopes, rule and probe event filters, and rule action targets. Passing the report still does not turn `simfile run` into an agent-backed composition.

## The composed-run path

The shipped repository drivers under `src/sims/` perform the real lifecycle:

```text
runWorldDrivenOfficeSim       live Simfile ticks around one office network
runComposedOfficeSim          simpler single-network composition
runComposedJungianSim         multi-network composition with interior teams
```

They use Spawnfile only through these documented command families:

```bash
spawnfile up <org> --detach --name <container> --deployment <name> --out <compiled> --json
spawnfile artifacts export <org> --deployment <name> --compiled <compiled> --out <run-dir> --json
spawnfile down <org> --deployment <name> --compiled <compiled> --json
```

Between `up` and export, the world communicates through Moltnet. Export always happens before teardown. The driver then adds its transcript and world artifacts and writes `manifest.json` last, so a directory is never presented as sealed before all declared evidence exists.

These drivers are repository dev/ops APIs exported from `src/sims/index.ts`. They are not a public npm export and there is currently no `simfile compose` command. This is the real path used by the office memetics and recursive Jungian fixtures; the CLI should not be documented as doing work it does not do.

## The artifact boundary

A composed run can contain:

```text
manifest.json                         simfile.run-manifest.v1 + SHA-256 entries
raw/moltnet/**/transcript.json        room messages
raw/moltnet/**/causal.jsonl           accepted-message causal events
raw/daimon/<agent>/causal.jsonl       wake and turn events
raw/mneme/<bank>/causal.jsonl         memory causal events
raw/mneme/<bank>/events.jsonl         bank content/fallback signal
raw/world/causal.jsonl                world clock, rules, and marker events
world/ingested-messages.jsonl         Moltnet message-to-world-tick join
world/telemetry.json                  variable samples
spawnfile-report.json                 optional topology and membrane metadata
spawnfile/up-receipt.json             optional per-agent engine provenance
```

Not every run has every optional artifact. The observer and viewer omit measurements and UI that lack evidence rather than manufacturing defaults.

## Why Moltnet is the meeting point

World actions use the same rooms as agent actions:

1. Simfile advances the deterministic clock and evaluates rules.
2. A world message or wake recommendation is delivered through Moltnet.
3. Spawnfile-managed agent bridges receive the room event.
4. Agents respond through their normal runtime and room connections.
5. Spawnfile exports each authority's causal and memory artifacts.
6. Simfile reconciles and replays the sealed result.

This keeps the causal path observable. A hidden wake or prompt injection would make the experiment easier to stage and harder to trust.

## Recursive organizations

The Jungian composed driver also copies the resolved Spawnfile report into the run. The viewer uses its team nodes, representative bindings, and managed-network room plans to derive membranes. It can then show the representative on the outer floor and the inner council as one causally linked society.

No special “mind” key enters the Simfile schema. Recursion is a property of the Spawnfile graph and the exported rooms.
