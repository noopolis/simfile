---
title: CLI
description: Simfile command reference.
---

## Validate

```bash
simfile validate ./Simfile
simfile validate ./Simfile --spawnfile-report .spawn/report.json
```

Parses and semantically checks a Simfile. With `--spawnfile-report`, validation
also checks declared agent, team, and room references against Spawnfile's
resolved graph report.

## Run

```bash
simfile run ./Simfile --ticks 144 --out runs/latest
simfile run ./Simfile --ticks 144 --out runs/latest --spawnfile-report .spawn/report.json
```

Runs the deterministic world kernel and writes a sealed run record with
`manifest.yaml`, `ledger.jsonl`, `telemetry.json`, `report.json`, and
`viewer-trace.json`.

## View

```bash
simfile view --state .sim --port 18787
simfile view runs/latest
```

Starts the local viewer. Replay defaults to the ASCII/tile console skin over the recorded run artifacts. Use `--no-open` when running in CI or remote shells.

## Planned Commands

```bash
simfile probes --ledger runs/latest/ledger.jsonl
simfile report --collect --out runs/latest
```

These are planned reporting conveniences. They will follow the same rule as
`validate`, `run`, and `view`: thin CLI, logic in modules.
