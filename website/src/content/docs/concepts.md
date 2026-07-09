---
title: Concepts
description: The core Simfile mental model.
---

## World, Not Mind

Simfile owns observable world state: time, pressure gauges, events, probes, and recordkeeping. Agent psychology belongs in Spawnfile docs and Mneme memories.

If a fixture needs a pressure like `evening_pull`, that is a variable with an author-chosen name. The schema does not know what it means.

## Determinism

Every run has a seed. Stochastic generators derive streams from `hash(run_seed, generator_id, tick, draw_index)`, so no shared PRNG state can leak across generators.

Wall cadence affects how fast the run feels. It does not affect the mechanical stream.

## Rules

Rules are the only reactive construct:

```yaml
rules:
  full_moon_rises:
    when:
      all:
        - variable: moon_fullness
          above: 0.95
        - phase: night
    do:
      - action: moltnet:message
        to: room:office-floor:after-work-chat
        content: "Full moon over the office."
```

Story beats are `fire: once` rules. Standing pressure laws are `per_crossing` rules.

## Markers

Markers are tracer dye. They do not plant content. They define literal strings to search for in rooms and memory exports.

Containment markers prove a secret stayed inside allowed scopes. Propagation markers prove a phrase actually spread.

## Live Viewer

`simfile view` is a lab instrument. It should show the current map, open portals into rooms and agents, and connect every visible claim to ledger evidence.
