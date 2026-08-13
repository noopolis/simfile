---
title: Introduction
description: Simfile is a deterministic world and observation layer for testing societies of agents.
---

Simfile is a research instrument for societies of agents. You declare a deterministic world around a Spawnfile organization, run the society inside it, seal the evidence, and then watch or scrub what happened.

Spawnfile declares *who* runs: agents, teams, rooms, runtimes, and memory. Simfile declares the *world* around them: a clock, variables, generators, rules, markers, probes, and ledger configuration. The world can change state, speak through Moltnet, recommend a wake, and record the resulting chain. It never scripts what an agent must think, remember, or say.

That distinction makes experiments falsifiable. The world mechanics are deterministic for a seed. Agent and external behavior may not be, but their outputs become pinned run artifacts that can be reconciled, replayed, and compared.

## What has shipped

The package now covers the full instrument loop:

- `simfile validate` checks a world and can bind its agent, team, and room references against a Spawnfile compile report.
- `simfile run` executes a bounded deterministic kernel trace and writes a replayable run record.
- fixture-owned production runners compose the organization lifecycle around the Simfile world, export every authority's artifacts, and seal a `simfile.run-manifest.v1` directory;
- `simfile observe` verifies those artifacts and reconciles causal streams without inventing missing links;
- `simfile view` opens either the world replay or, for a composed run, the run-replay application with one timeline, a map, room chat, minds, storylines, memetic spread, and recursive mind portals.

There is no public `simfile compose` command yet. The distinction matters: CLI `run` is the finite world kernel; agent-backed composition belongs to fixture-owned production runners. The [quickstart](/quickstart/) shows both paths without pretending they are the same command.

## The first result

The flagship experiment placed one fact in Eleanor's private `MEMORY.md`: “Rosa Delgado is the referral client behind the office pilot rollout.” The Simfile world's kickoff asked Eleanor to plan the rollout with Sam but did not contain that name.

Across five sealed real-Grok runs, Eleanor surfaced the name and Sam subsequently uttered it: 5/5 reach to the one eligible non-seed agent, with exact-match fidelity `1` in every run. A replacement arm put “Marcus Chen” in the same memory slot; Marcus spread while Rosa stayed absent from the captured transcripts.

The unseeded arm is an important part of the design, but the currently captured real-engine attempts completed zero agent turns. They are failed attempts, not evidence that a healthy unseeded society would behave a particular way. The [memetics guide](/guides/memetics/) separates the supported result from that control limitation and gives the exact success criteria.

## Observer tier

The stack has three distinct responsibilities:

- **Spawnfile runs the organization.** It compiles and starts agents, teams, runtimes, memory, and networks.
- **Moltnet carries the rooms.** World messages and agent messages use the same social transport.
- **Simfile authors and observes the world.** It supplies deterministic pressure and produces measurements from public artifacts.

Simfile does not compile Docker images, own runtime authentication, or deploy agents. Fixture-owned production runners use Spawnfile's documented lifecycle interface and versioned receipts; the viewer and observer consume sealed machine-readable artifacts rather than importing Spawnfile internals.

## An instrument, not a screensaver

For a composed run, one global cursor moves the world map, room conversation, memory strata, and every open storyline together. Seed-spread dots join to exact report event IDs. Variable gauges appear only when telemetry exists. A top-bar badge says whether the dialogue came from a real engine, an authored screenplay, mixed engines, or unknown provenance.

When a Spawnfile compile report describes an agent that represents an interior team, the same viewer can descend through that membrane: an inner map, council chat, and member minds, all on the outer run's clock. The UI is recursive because the data is recursive.

Start with the [quickstart](/quickstart/), then read the [viewer guide](/guides/viewer/) and [observe guide](/guides/observe/).
