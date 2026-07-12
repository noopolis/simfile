# Simfile

> Deterministic simulation worlds for societies of agents — seed an idea, run the world, and watch it move through minds.

<p align="center">
  <a href="https://www.npmjs.com/package/simfile"><img src="https://img.shields.io/npm/v/simfile?style=flat-square&color=7c5cff&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/simfile"><img src="https://img.shields.io/npm/dm/simfile?style=flat-square&color=7c5cff" alt="downloads"></a>
  <a href="#install"><img src="https://img.shields.io/node/v/simfile?style=flat-square&color=7c5cff" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/simfile?style=flat-square&color=7c5cff" alt="MIT"></a>
  <a href="https://simfile.org"><img src="https://img.shields.io/website?url=https%3A%2F%2Fsimfile.org&style=flat-square&label=simfile.org&color=7c5cff" alt="website"></a>
</p>

Spawnfile declares *who* runs and how an organization is wired — agents, teams, rooms, runtimes, memory. **Simfile declares the *world* around them** — a clock, variables, generators, rules, markers, probes, and a run ledger — then runs it and lets you watch.

Seed a secret into one agent's memory and watch it spread through the society, tick by tick. Open an agent that is *itself* an organization — a Jungian self whose Shadow and Anima deliberate in an inner room — and descend into it. Every message, wake, turn, memory write, and variable change is a ledger event, so the viewer scrubs the whole run backward and forward and every glyph on screen traces to a record.

Deterministic and replayable. Observer-tier by design: Simfile authors and observes worlds — it compiles no Docker images and deploys no agents. That is [**Spawnfile**](https://spawnfile.com)'s job (the organization that runs *in* the world), talking over [**Moltnet**](https://moltnet.dev) (the rooms the agents share).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What you can see](#what-you-can-see)
- [The world](#the-world)
- [Example](#example)
- [Observe](#observe)
- [Repo guide](#repo-guide)
- [Docs](#docs)

## Install

```bash
npm install simfile
simfile --help
```

Node.js 22+.

## Quick start

```bash
simfile validate ./Simfile.yaml     # check a world
simfile view runs/<id>              # replay a sealed run — scrub, descend, watch spread
simfile view --state .sim           # watch a live world
simfile observe runs/<id>           # reconcile causal chains + measure spread → report.json
```

## What you can see

`simfile view <run-dir>` serves a local web app that turns a run into an instrument, not a screensaver:

- **Scrub the whole run.** One causally-ordered timeline — play, rewind, step. The world map, the room chat, and every agent's memory all move together off a single cursor.
- **Watch a meme spread.** A secret seeded *only* in one agent's private memory surfaces in conversation and reaches others on its own; the timeline lights up where it lands, with reach, latency, and match fidelity — re-derived from the sealed run, never faked.
- **Descend into a mind.** Click an agent that is itself an org (a Jungian self) and drop into its inner council: the archetypes deliberate, the representative synthesizes and answers out. Recursion by data — an agent *is* an organization you haven't opened yet.
- **Per-element storylines.** An agent, a room, a memory bank, a variable — each has its own timeline you can open, all linked to the one global cursor.

Every element carries its real ledger id, and a run-header badge always discloses whether the dialogue came from real engines or a scripted screenplay.

## The world

A `Simfile` declares world mechanics, kept deliberately genre-neutral:

| Key | What it is |
|---|---|
| **clock** | ticks, phases, sim-time |
| **variables** | scoped state with ranges |
| **generators** | deterministic or stochastic drivers that move variables |
| **rules** | `when` conditions → effects (wake an agent, post a world message) |
| **markers** | scan room traffic for tokens (a seeded secret, a name) |
| **probes** | scored assertions evaluated over a run |
| **run ledger** | the canonical, causally-ordered record everything else is measured against |

Domain concepts live in fixtures, never in schema keys.

## Example

```yaml
simfile_version: "0.1"
name: autonomous-office-world
spawnfile: ./Spawnfile

clock:
  seed: office-run-014
  tick: 20s
  sim_per_tick: 10m
  phases: { morning: "07:00", workday: "09:00", evening: "18:00", night: "22:00" }

variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1

generators:
  deadline_ramp:
    kind: deterministic
    when: { phase: workday }
    variable: filing_pressure
    delta: 0.02

rules:
  deadline_bites:
    when: { variable: filing_pressure, above: 0.85 }
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom

markers:
  tenant_name:
    text: [Rosa Delgado]
    mode: containment
    scopes: [room:office-floor:case-warroom]

probes:
  deadline_observed:
    when: { event: wake.recommended, target: room:office-floor:case-warroom }
    expect: { at_least: 1 }
```

## Observe

`simfile observe <run-dir>` reconciles every authority's causal stream — Moltnet, Daimon, Mneme, and the world kernel — into one honest verdict: complete vs. incomplete causal chains, per-agent memory, failures, and, for a seeded world, spread measurement (channel · reach · latency · fidelity) re-derived from sealed artifacts. Ordering is causal, never wall-clock; a missing link is reported, never stitched.

## Repo guide

```text
src/schema      v0.1 world schema + validator
src/runtime     deterministic world kernel (clock, generators, rules, markers, probes)
src/observe     causal reconciliation + spread measurement
src/view + web  the run-replay viewer (React), served by `simfile view`
src/sims        composed-run drivers (shell Spawnfile, seed, observe)
docs/           design + research (DESIGN, VIEW_DESIGN, VIEW_STYLEGUIDE, …)
```

Simfile hardcodes constraints, not conclusions: it defines stable mechanics and observability, and leaves interpretation, strategy, dialogue, memory choice, and culture to the agents.

## Docs

Full documentation at [**simfile.org**](https://simfile.org). Design and research notes live in [`docs/`](docs/).

## License

MIT
