---
title: Concepts
description: The mental model behind deterministic worlds, sealed runs, causal observation, and recursive agent societies.
---

## The world is deterministic; the society is not

A Simfile seed fixes the mechanical stream: clock ticks, stochastic draws, generator order, rule evaluation, and world effects. `simfile run --local --ticks <n>` can reproduce that stream byte for byte from the same inputs.

Agents and external systems can still be nondeterministic. Simfile makes their outputs inspectable by sealing them as inputs to replay and observation. “Deterministic” describes the world kernel, not a promise that a model will say the same thing twice.

## World, not mind

Simfile owns observable world state: time, scoped variables, deterministic and stochastic drivers, reactions, tracer markers, probes, and records. It does not own personality, psychology, strategy, or culture.

If a fixture needs `filing_pressure`, that is an author-chosen variable ID. The schema does not know what the pressure means. Agent instructions belong in Spawnfile documents; durable and recalled experience belongs in Mneme artifacts.

This is the core authoring rule: hardcode constraints, not conclusions.

## One social transport

The world is a Moltnet participant. A `moltnet:message` or `moltnet:dm`
action travels through the same room topology the organization already uses.
There is no hidden wake or prompt path that lets the experiment inject an
answer directly into an agent.

That is especially important for memetics. A kickoff can ask Eleanor to discuss an office rollout, but it must not contain the seeded name. If the name appears, the evidence must come from the agent's recorded utterance or memory, not the instrument's own message.

## Two run records

The current package produces two related but distinct artifact shapes:

- a **kernel run** from `simfile run --local --ticks <n>`, with `manifest.yaml`, canonical `ledger.jsonl`, telemetry, a kernel report, and `viewer-trace.json`;
- a **composed run** from linked `simfile run <Simfile>`, with `manifest.json` at `simfile.run-manifest.v1`, exported `raw/**/causal.jsonl` streams, transcripts, memory artifacts, and optional world telemetry.

Kernel runs exercise world mechanics. Linked composition delegates
organization lifecycle through Spawnfile and requires the project's binding
plus Simfile's `simfile.spawnfile-public-capability-probe.v1`, derived only
from documented generic Spawnfile CLI surfaces. Composed runs contain the
cross-authority evidence needed by `simfile observe` and the full run-replay
viewer.

## Causal order before wall time

Distributed logs disagree about clocks. Simfile therefore treats recorded causal links and per-stream sequence numbers as stronger evidence than timestamps.

The observer reconciles each event and reports incomplete states such as `partial`, `unknown`, or `divergent`. It never creates a missing event to make a chain look complete. Agent turns are ordered by the Moltnet message sequence that triggered them, not by `recorded_at`.

The viewer begins with deterministic record ordering and then moves causes before their effects when necessary. This is a causal repair of presentation order, not a synthetic link.

## Markers, probes, and seed spread

These answer different questions:

- **Markers** scan world-event payload text for authored aliases. `containment` checks for an in-scope hit with no out-of-scope hit; `propagation` checks for a hit in a declared scope.
- **Probes** evaluate a `when` condition against a finite kernel run and apply an expectation such as `at_least` or `at_end`.
- **Seed spread** is an observer measurement over a composed run. It independently scans sealed transcripts and Mneme artifacts for `doc-seeded`, `uttered`, `registered`, and `recalled` appearances.

The seed-spread observer does not trust the live world's `marker.seen` event as its evidence. It re-derives the result from artifacts and uses the live marker only as a diagnostic cross-check.

## Membranes

An agent can itself be represented by a Spawnfile team with an interior Moltnet network. The outer agent is then a membrane: a representative speaks on the public floor while an inner council deliberates behind it.

When a composed run includes compatible `spawnfile-report.json` metadata, the viewer derives that membrane. Descending opens an interior map, filtered chat, member minds, and a crossings view for the representative, all on the same global cursor. Ordinary leaf agents do not get an invented interior.

## Pixel accountability

The viewer follows an accountability discipline: messages come from transcripts and causal events; memory strata come from Mneme artifacts; phase bands come from `clock.sync`; variables appear only with telemetry; spread dots join exact report event IDs; artifact status comes from manifest SHA-256 checks.

Some presentation is necessarily derived: deterministic auto-layout, synthesized team nodes for membranes, and heuristic positions in chat-only runs. Those pixels do not become simulation facts. The shipped viewer does not yet provide a universal “click any pixel to inspect its source” tool, so pixel accountability is a constraint on claims, not a claim that every decorative pixel has an inspector.
