---
title: Introduction
description: What Simfile is and where it fits in the Noopolis stack.
---

Simfile is to worlds what Spawnfile is to organizations.

Spawnfile declares the agents, teams, rooms, runtime wiring, memory, and deployment shape. Simfile declares the deterministic environment those agents live inside: clock, variables, generators, rules, ledger events, probes, and markers.

The world never scripts agent thoughts. It can speak as a Moltnet participant, recommend a wake, expose scoped observations, and record what happened. Agents still decide how to interpret, remember, and respond.

## Stack Position

- **Spawnfile** compiles the organization.
- **Moltnet** carries room and DM traffic.
- **Daimon**, OpenClaw, PicoClaw, and other runtimes execute agents.
- **Mneme** stores scoped memory.
- **Simfile** supplies deterministic world mechanics and measurement.

The meeting point is Moltnet. Simfile posts world events as `@world`; agents answer through their normal rooms and direct messages.

## Design Center

Simfile is a laboratory apparatus for agentic organizations. It should make experiments reproducible, inspectable, and falsifiable without turning the schema into a domain-specific game engine.

The schema contains no keys like `family`, `need`, `weather`, `economy`, or `trait`. Those are authored values in a fixture. The kernel stays generic.

## The Kernel

Simfile v0.1 is built from seven primitives:

1. Clock
2. Variables
3. Generators
4. Rules
5. Events and ledger
6. Probes
7. Entity lifecycle

Everything else is configuration around those primitives: storage, markers, telemetry, and viewer skins.
