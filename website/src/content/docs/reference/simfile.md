---
title: Simfile Schema
description: The v0.1 configuration reference.
---

## Top-Level Keys

```yaml
simfile_version: "0.1"
name: office-world
spawnfile: ./Spawnfile
clock:
  seed: office-run-014
  tick: 20s
variables: {}
generators: {}
rules: {}
ledger: {}
telemetry: {}
markers: {}
probes: {}
```

`simfile_version`, `name`, and `clock.seed` plus `clock.tick` are required.
`spawnfile` is optional.

## Clock

```yaml
clock:
  seed: office-run-014
  tick: 20s
  sim_per_tick: 10m
  phases:
    morning: "07:00"
    workday: "09:00"
```

`tick` is wall cadence. `sim_per_tick` is simulated time advanced per tick.

## Variables

Variables are scoped gauges.

```yaml
variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1
```

Variables can be driven, measured, fed by an instrument, or derived by an equation.

## Generators

```yaml
generators:
  deadline_ramp:
    kind: deterministic
    when:
      phase: workday
    variable: filing_pressure
    delta: 0.02
```

v0.1 supports deterministic and stochastic generators.

## Rules

```yaml
rules:
  deadline_bites:
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
```

Rules are `when -> do`. The default fire mode is `per_crossing`; use `fire: once` for story beats.

## Markers And Probes

Markers trace literal content. Probes evaluate falsifiable claims.

```yaml
markers:
  tenant_name:
    text:
      - Rosa Delgado
    mode: containment
    scopes:
      - room:office-floor:case-warroom

probes:
  deadline_observed:
    when:
      event: wake.recommended
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
```
