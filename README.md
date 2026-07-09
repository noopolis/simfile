# Simfile

Simfile declares deterministic simulation worlds for agentic organizations.

Spawnfile declares who runs and how the organization is wired: agents, teams,
rooms, runtimes, memory, resources, and networks. Simfile declares the world
around that organization: clock, variables, generators, rules, markers, probes,
and the run ledger.

The package currently contains:

- a v0.1 schema and validator;
- deterministic kernel helpers for durations, ranges, and stochastic draws;
- marker scanning and probe evaluation helpers;
- `simfile view`, a local live viewer server with a bundled GlyphCSS web app;
- a separate Astro/Starlight documentation site under `website/`.

Simfile does not compile Docker images or deploy agents. It authors and runs
world mechanics that a Spawnfile organization can consume through Moltnet,
runtime tools, and ledger exports.

## Install

```bash
npm install simfile
```

## Validate

```bash
simfile validate ./Simfile.yaml
```

## View

```bash
simfile view --state .sim --port 18787
simfile view runs/latest
```

The viewer is shipped with the npm package from `web/dist`. The public website
in `website/` is separate and is not bundled into the runtime package.

## Example

```yaml
simfile_version: "0.1"
name: autonomous-office-world
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

## Boundary

Simfile should hardcode constraints, not conclusions. It defines stable
mechanics and observability while leaving interpretation, strategy, dialogue,
memory choice, and culture to agents.
