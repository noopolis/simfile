# Simfile

Simfile is the declarative world-mechanics layer for agentic simulations.

Spawnfile declares who runs and how the organization is wired: agents, teams,
rooms, runtimes, memory, resources, and networks. Simfile declares the world
those agents inhabit: time, locations, needs, pressures, actions, salience, and
the event ledger.

The setup is intentionally similar to Spawnfile: a package, schema, CLI, tests,
and documentation. The scope is different. Simfile does not compile Docker
images or deploy agents. It authors and runs simulation mechanics that a
Spawnfile organization can consume as tools, resources, and ledger streams.

In practice:

- Spawnfile starts the agentic organization.
- Simfile defines the simulated world around that organization.
- Daimon, OpenClaw, PicoClaw, or another runtime execute the agents.
- Moltnet carries room and direct-message traffic.
- Mneme stores and retrieves scoped memory.

## Install

```bash
npm install simfile
```

## Validate

```bash
simfile validate ./Simfile.yaml
```

## Example

```yaml
simfile_version: "0.1"
kind: simulation
name: autonomous-office-world

clock:
  tick: 20s
  phases:
    - id: morning
      starts: "07:00"
    - id: workday
      starts: "09:00"
    - id: evening
      starts: "18:00"
    - id: night
      starts: "22:00"

actors:
  - id: eleanor
    agent: eleanor
    needs:
      family_presence: 0.72
      case_control: 0.88
      rest: 0.31
    traits:
      conscientiousness: 0.91
      delegation_resistance: 0.73

locations:
  - id: case-warroom
    room: office-floor:case-warroom
    pressures:
      filing_deadline: 0.94

actions:
  - id: update_case_posture
  - id: ask_for_handoff
  - id: go_home
  - id: file_response

salience:
  wake_when:
    - pressure: filing_deadline
      above: 0.8
    - need: family_presence
      below: 0.35

ledger:
  events:
    - case.progressed
    - promise.made
    - promise.broken
    - trust.changed
    - memory.promoted
```

## Boundary

Simfile should hardcode constraints, not conclusions. It should define stable
mechanics and observability, while leaving interpretation, strategy, dialogue,
memory choice, and culture to the agents.
