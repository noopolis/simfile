---
title: Quickstart
description: Validate a Simfile and open the live viewer.
---

Install from npm once it is published:

```bash
npm install -g simfile
```

Validate a world:

```bash
simfile validate ./Simfile
```

Open the live viewer against a state directory:

```bash
simfile view --state .sim --port 18787
```

Open a recorded run:

```bash
simfile view runs/latest
```

## Minimal World

```yaml
simfile_version: "0.1"
name: tiny-world

clock:
  seed: run-001
  tick: 30s
```

`spawnfile:` is optional. A pure mechanical world is valid, which keeps the kernel testable before agents are attached.

## Office-Style World

```yaml
simfile_version: "0.1"
name: office-world
spawnfile: ./Spawnfile

clock:
  seed: office-run-014
  tick: 20s
  sim_per_tick: 10m
  phases:
    morning: "07:00"
    workday: "09:00"
    evening: "18:00"
    night: "22:00"

variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1

generators:
  deadline_ramp:
    kind: deterministic
    when:
      phase: workday
    variable: filing_pressure
    delta: 0.02

rules:
  deadline_bites:
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
```

The world raises pressure and recommends a room wake. It does not tell the agents what to think or say.
