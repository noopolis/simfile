---
title: Spawnfile Integration
description: How Simfile composes with Spawnfile without duplicating it.
---

Simfile does not re-parse Spawnfile YAML.

`simfile validate` and `simfile run` can consume Spawnfile's machine-readable
resolved graph report through `--spawnfile-report`. That keeps one source of
truth for agents, teams, rooms, runtimes, memory, and deployment wiring.

```bash
spawnfile compile ./Spawnfile --report-json .spawn/report.json
simfile validate ./Simfile --spawnfile-report .spawn/report.json
simfile run ./Simfile --ticks 144 --out runs/latest --spawnfile-report .spawn/report.json
```

The binding check is part of validation and run setup. It is not a separate
public planning command.

## Target Runtime Flow

1. Spawnfile starts the organization.
2. Simfile starts the world runtime.
3. Simfile joins Moltnet as a world participant.
4. World rules post room messages, DMs, and wake recommendations.
5. Agents respond through their normal runtime bridges.
6. Simfile observes rooms, ledgers events, and evaluates probes.

The world talks through the same channels as everyone else. There is no private wake path.

## Why This Split Matters

Spawnfile should stay responsible for the organization. Simfile should stay responsible for world mechanics and measurement. The boundary makes each package testable on its own.
