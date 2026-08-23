---
title: Simfile Schema
description: The exact Simfile v0.1 world schema accepted by the current validator and kernel.
---

Simfile v0.1 is a strict, genre-neutral YAML or JSON schema. Unknown keys are rejected. IDs name authored concepts; the schema never assigns domain meaning to them.

## Minimal file

```yaml
simfile_version: "0.1"
name: tiny-world

clock:
  seed: run-001
  tick: 30s
```

`simfile_version`, `name`, and `clock` are required. All collection sections default to empty maps.

## Top-level keys

| Key | Required | Value |
| --- | --- | --- |
| `simfile_version` | yes | Exactly `"0.1"`. |
| `name` | yes | A Simfile identifier. |
| `spawnfile` | no | Project-relative Spawnfile link. Validation and explicit local runs retain it without resolving or starting Spawnfile; a default linked run resolves it and delegates lifecycle through Spawnfile when the project binding and operator prerequisites exist. |
| `clock` | yes | Run seed, tick duration, optional simulation rate and phases. |
| `places` | no | Map of place ID to authored spatial metadata; defaults to `{}`. |
| `routes` | no | Map of route ID to connected place IDs; defaults to `{}`. |
| `presence` | no | Map of agent ID to its initial place; defaults to `{}`. |
| `variables` | no | Map of variable ID to variable record; defaults to `{}`. |
| `generators` | no | Map of generator ID to generator record; defaults to `{}`. |
| `rules` | no | Map of rule ID to rule record; defaults to `{}`. |
| `world` | no | World identity and participant grants for an authored sidecar. |
| `world_sidecar` | no | Trusted project-relative binding and composer modules for linked composition. |
| `dynamics` | no | Project-relative deterministic dynamics provider and JSON configuration. |
| `ledger` | no | Ledger store configuration. |
| `telemetry` | no | Snapshot sampling configuration. |
| `markers` | no | Map of marker ID to marker record; defaults to `{}`. |
| `probes` | no | Map of probe ID to probe record; defaults to `{}`. |

## Shared lexical forms

Identifiers match:

```text
[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*
```

They start with a lowercase letter and use lowercase letters, numbers, dashes, or underscores. This form is used for the world name, map keys, phase references, variable references, and `fed_by`.

Durations are a non-negative decimal followed by `ms`, `s`, `m`, `h`, `d`, or `w`, for example `250ms`, `20s`, `1.5m`, or `2h`. The schema accepts zero, but `clock.tick` and `clock.sim_per_tick` must be positive at runtime.

Ranges are two signed numbers separated by `..`, with the lower value strictly less than the upper value:

```text
-1..1
0..100
```

Scopes have exactly these forms:

```text
global
agent:<id>
team:<id>
room:<network>:<room>
pair:<a>:<b>
```

## Clock

```yaml
clock:
  seed: office-run-014
  tick: 20s
  sim_per_tick: 10m
  phases:
    morning: "07:00"
    workday: "09:00"
    evening: "18:00"
    night: "22:00"
```

| Field | Required | Meaning |
| --- | --- | --- |
| `seed` | yes | Non-empty deterministic run seed. `simfile run --local --ticks <n> --seed` can override it. |
| `tick` | yes | Positive duration of one kernel tick. |
| `sim_per_tick` | no | Simulated duration advanced per tick; defaults to `tick`. |
| `phases` | no | Map of phase ID to 24-hour `HH:MM`; defaults to `{}`. |

The finite `simfile run --local --ticks <n>` loop does not sleep. `tick` becomes wall cadence only when a live driver chooses to wait between kernel steps. Phase selection repeats over a 24-hour simulated day.

## Variables

```yaml
variables:
  filing_pressure:
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1
```

Each `variables.<id>` record accepts:

| Field | Required | Meaning |
| --- | --- | --- |
| `scope` | yes | One valid scope. |
| `initial` | no | Numeric initial value; defaults to `0` and is clamped to `range`. |
| `range` | yes | Strict lower and upper bounds in `min..max` form. |
| `measure` | no | Declares a measured source. |
| `derive` | no | Declares a pure expression source. |
| `fed_by` | no | Reserves writes for one instrument/actor ID. |

A variable may use at most one of `measure`, `derive`, or `fed_by`.

### Measured variables

```yaml
variables:
  hall_heat:
    scope: room:office-floor:office-hall
    range: 0..40
    measure:
      kind: messages_in
      scope: room:office-floor:office-hall
      window: 30m
```

`measure` requires `kind` and `window`; its `scope` is optional. The accepted `kind` values are:

```text
messages_in
token_mentions
marker_violations
distinct_speakers
mentions_of
ticks_since_last_message
```

These records validate today, but the finite `simfile run --local --ticks <n>` batch runtime does not yet compute measured inputs. Do not treat a validated `measure` as a populated counter in that path.

### Derived variables

```yaml
variables:
  social_weather:
    scope: global
    range: 0..1
    derive:
      eq: 0.015 * hall_heat + 0.6 * evening_pull
```

`derive` contains exactly one non-empty `eq` string. All variable dependencies must exist, and derived-variable cycles fail at runtime compilation.

### Fed variables

```yaml
variables:
  adjudicated_signal:
    scope: global
    range: 0..1
    fed_by: referee
```

`fed_by` names the only actor authorized to set that variable through a queued `world.act`. A generator or rule action targeting the same fed variable is a validation error.

## Expressions

`derive.eq`, deterministic `delta_eq`, and deterministic `set_eq` use the same closed numeric expression language.

Operands are numbers, duration literals, declared variable IDs, and the reserved values `t`, `tick`, `pi`, and `e`. Operators are unary `+`/`-` and binary `+`, `-`, `*`, `/`, and `**`, with parentheses. Division by zero and non-finite results become `0`.

The accepted functions are:

```text
abs ceil clamp cos exp floor lerp log max min mod pow
sin smoothstep sqrt step
```

Expressions cannot assign, branch, loop, call arbitrary code, or draw randomness.

## Conditions

Generators, rules, and probes share one recursively nestable `when` shape.

### Variable threshold

```yaml
when:
  variable: filing_pressure
  above: 0.85
  below: 0.95
  for: 30m
```

`variable` must name a declared variable. At least one of `above` or `below` is required; comparisons are strict `>` and `<`. Optional `for` requires the condition to remain true for that much simulated time.

### Phase

```yaml
when:
  phase: workday
```

The phase must be declared under `clock.phases`.

### Event

```yaml
when:
  event: wake.recommended
  target: room:office-floor:case-warroom
  actor: deadline_bites
  scope: room:office-floor:case-warroom
```

`target` and `actor` are optional strings; `scope` is an optional valid scope. Event kind is one of:

```text
clock.sync
rule.fired
world.message
world.dm
world.act
wake.recommended
marker.seen
```

### Composition

```yaml
when:
  all:
    - phase: workday
    - any:
        - variable: filing_pressure
          above: 0.85
        - not:
            event: marker.seen
```

The composition records are `all` with a non-empty condition list, `any` with a non-empty condition list, or `not` with one condition. A bare condition list is invalid.

## Generators

Generators target one declared, non-fed variable and may have an optional shared `when` condition.

### Deterministic

```yaml
generators:
  deadline_ramp:
    kind: deterministic
    when:
      phase: workday
    variable: filing_pressure
    delta: 0.02
```

A deterministic generator requires exactly one writer:

- `delta`: add a constant each active tick;
- `delta_eq`: add the result of an expression; or
- `set_eq`: replace the value with the result of an expression.

### Stochastic

```yaml
generators:
  day_texture:
    kind: stochastic
    variable: evening_pull
    uniform: [-0.01, 0.03]
```

A stochastic generator requires `uniform`, a two-number tuple. It draws once per active tick from the stream derived from the run seed, generator ID, tick, and draw index, then adds the result to the target. Values are clamped to the variable range after generator application.

## Rules

```yaml
rules:
  deadline_bites:
    fire: per_crossing
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "The filing deadline is now urgent."
```

| Field | Required | Meaning |
| --- | --- | --- |
| `fire` | no | `once` or `per_crossing`; defaults to `per_crossing`. |
| `when` | yes | One shared condition tree. |
| `do` | yes | Non-empty action list. |

`once` fires on the first matching tick. `per_crossing` fires on each false-to-true transition.

Actions have exactly these shapes:

```yaml
- action: moltnet:message
  to: room:<network>:<room>
  content: "Pressure is {filing_pressure}."

- action: moltnet:dm
  to: agent:<id>
  content: "A private world message."

- action: variable:set
  variable: <variable-id>
  value: 0.5

- action: variable:delta
  variable: <variable-id>
  value: 0.1

- action: move
  agent: <agent-id>
  to: <place-id>
```

Room messages require a room scope; DMs require an agent scope. Variable
actions require a declared, non-fed variable. `move` requires a declared agent,
destination place, and a route from its current place. Braced placeholders in
message content must name declared variables.

## Markers

```yaml
markers:
  referral_client:
    text:
      - "Rosa Delgado"
      - "Ms. Delgado"
    mode: propagation
    scopes:
      - room:office-floor:case-warroom
```

| Field | Required | Meaning |
| --- | --- | --- |
| `text` | no | List of non-empty aliases. If absent or empty, the marker ID is the alias. |
| `mode` | yes | `containment` or `propagation`. |
| `scopes` | yes | Non-empty list of valid scopes. |

Matching is case-insensitive and uses Unicode word boundaries over text-like event payload fields. A containment marker passes only with at least one in-scope hit and no out-of-scope hit. Current propagation evaluation passes with at least one hit in any declared scope; it does not require every scope.

## Probes

```yaml
probes:
  deadline_observed:
    when:
      event: wake.recommended
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
```

| Field | Required | Meaning |
| --- | --- | --- |
| `when` | yes | Condition being tested. |
| `expect` | yes | Exactly one expectation shape. |
| `after` | no | Anchor condition for a bounded window. |
| `within` | no | Duration after the anchor; required with `after`. |

Expectation shapes are:

```yaml
expect:
  at_least: 1

expect:
  at_most: 0

expect:
  always: true

expect:
  at_end: true
```

`at_least` and `at_most` take non-negative integers. `after` and `within` must either both be present or both be absent.

## Ledger

```yaml
ledger:
  store:
    kind: jsonl
    path: .sim/ledger.jsonl
```

`ledger.store` is required when `ledger` is present. `store.kind` is optional and defaults to `jsonl`; accepted values are `jsonl`, `sqlite`, and `postgres`. `store.path` is an optional non-empty string.

The current finite `simfile run --local --ticks <n>` writer always emits `<out>/ledger.jsonl`; it does not route that run record through the configured store kind or path.

## Telemetry

```yaml
telemetry:
  snapshot_every: 50
```

`snapshot_every` is an optional positive integer. When absent, `simfile run --local --ticks <n>` writes every variable sample. When present, it keeps samples at ticks divisible by that value and also keeps the final sample.

## Spawnfile binding

```bash
simfile validate ./Simfile --spawnfile-report .spawn/spawnfile-report.json
```

Without the report, scope strings are checked only for shape. With it, Simfile builds an index from Spawnfile report nodes and their active Moltnet room bindings. Binding checks cover variable scopes, marker scopes, rule and probe event filters, and rule action destinations. The current binding pass does not inspect `measure.scope`, pair members, or generator event filters. The report is an explicit validation input: `simfile validate` and `simfile run --local --ticks <n>` do not resolve, compile, or start the `spawnfile:` link. Default linked `simfile run <Simfile>` is the separate path that resolves the link and delegates lifecycle through Spawnfile, subject to its required project binding and explicit operator prerequisites.
