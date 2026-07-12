---
title: Presentation Packs
description: A short appendix on viewer-owned presentation that never changes Simfile semantics.
---

Presentation belongs to the viewer, not the Simfile schema. The same run can be arranged as a compact glyph map, office floor, abstract organization map, or another visual surface without changing one world fact.

The current viewer ships a small built-in skin list and deterministic auto-layout. Rooms, agents, variables, and membranes are keyed by stable artifact IDs; no schema field sets colors, models, camera positions, or embodiment.

This boundary protects two properties:

- a run with no presentation pack still renders;
- changing presentation cannot change the clock, rules, causal record, observation result, or replay.

The renderer may derive layout and synthesize visual anchors—for example, a `team:<id>` node next to its representative when a mind membrane is present. Those are labeled presentation choices, not ledger events.

There is no `simfile skin` command and no public skin manifest flag in v0.1. Treat custom presentation packs as an appendix and future viewer surface, not as world-authoring keys or the headline capability. The shipped instrument is described in the [viewer guide](/guides/viewer/).
