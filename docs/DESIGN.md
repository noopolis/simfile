# Simfile Design

Simfile is to worlds what Spawnfile is to organizations: it declares, derives,
and measures; it never interprets.

The pitch in one paragraph: Simfile is a deterministic world kernel for agent
societies. It supplies time, pressure, stimuli, measurement, and falsifiable
probes around nondeterministic agents, so multi-agent behavior can be
replayed, audited, and tested without scripting the agents themselves — CI
for agentic social systems.

The determinism claim, stated up front so nobody over-reads it: the world is
deterministic; the society is not. Byte-identical replay covers the
mechanical stream; agentic and external events are pinned inputs. The record
makes the nondeterminism inspectable, replayable as input, and testable.

Simfile is the declarative simulation layer for Noopolis-style agentic
organizations. Spawnfile answers "who runs, where, with which runtime and
network." Simfile answers "what world pushes back on them, what actions exist,
what changes count, and how the run is observed."

The package should feel like Spawnfile in ergonomics: a schema, CLI, readable
YAML, validation, tests, docs, and reproducible artifacts. It should not become
Spawnfile. It should not compile Docker images, own runtime auth, or deploy
agent containers. Instead, it produces simulation plans, world tools, ledgers,
reports, and optional patches to the authored world.

## Design Rules

1. Zero domain nouns in the schema. No key or enum may name a world concept:
   family, need, trait, weather, economy, faith, brand, or similar. Domain
   concepts exist only as authored values in fixtures. Enforcement is
   mechanical: a lint greps schema definitions for a blocklist of domain
   vocabulary and runs in CI like any other test.

2. The kernel is seven primitives: clock, variables, generators, rules,
   events/ledger, probes, and entity lifecycle. Any proposed schema addition
   must first show it cannot be expressed as authored content over these seven.
   This is the sibling of Spawnfile's derivation rule. Entity lifecycle is
   reserved, not active: it has no schema keys and no possible writer until
   v3, so this rule effectively governs six primitives today.

3. The two-fixtures rule. No schema key ships unless at least two fixtures from
   different genres use it, for example the office sim and a brand/market sim.
   A key only one genre needs is domain content wearing a schema costume.
   Enforced at release tags, not mid-development — and the brand/market
   fixture is therefore a v0.1 deliverable, so the rule can bite before the
   first tag rather than being waived by it.

4. One equation grammar, no general-purpose language. Set-generators,
   `delta_eq:`, and derived variables use `eq:` — a closed, pure, total math
   expression grammar (arithmetic, a frozen function list, `t`/`tick`,
   duration literals, variable ids). It is versioned, side-effect free, and
   deterministic; identifiers are authored variable ids, so the domain-noun
   rule is untouched. Rule conditions and effects remain data records:
   threshold atoms composed with nestable `all`/`any`/`not` blocks — logic is
   structure, math is `eq`. A condition that needs arithmetic gets a name
   first: derive an `eq` variable and threshold it.
   Anything beyond pure math is not an expression: randomness comes only from
   stochastic generators, loops only through state with a one-tick delay,
   models from steered instruments.

5. No authored interiority. Simfile variables are observable world state. Agent
   psychology, character, and culture live in Spawnfile-side docs and Mneme
   memory. If an author wants a per-actor pressure, it is a variable with an
   author-chosen name; the schema never calls it a need or a trait.

6. Steered forces are agents, not schema. A market, a god, a rival brand, or a
   weather service with moods is an agent declared in Spawnfile and speaking
   through the same channels. Simfile ships only mechanical generator kinds:
   deterministic and stochastic. Authored story is expressed as `fire: once`
   rules, with the same ledger and probe visibility as every other reaction.
   Every stochastic generator is seeded from the run seed.

7. The world speaks through existing channels. Simfile posts events as a Moltnet
   participant and owns no wake path, clock injection path, or prompt surface.
   Simfile's clock is the only world clock; fixture-local tools such as
   `office-clock` migrate into Simfile.

8. Determinism is non-negotiable. Every run takes one seed. Stochastic
   generators derive their streams from `hash(run_seed, generator_id)`. State is
   rebuildable from source, seed, ledger, and patches. The same run inputs must
   produce a byte-identical canonical ledger export.

9. Semantics align with Spawnfile. Adopt the Mneme scope grammar for ledger
   scopes (`room:<network>:<room>`, `team:<team>`, `pair:<a>:<b>`) so ledger
   events join memory scopes directly; the compiler's status subjects use a
   provider-prefixed form (`room:moltnet:<network>:<room>`), and unifying the
   two grammars is an open question. Use `*_version: "0.1"`, snake_case keys, the shared
   error taxonomy (`validation_error`, `compile_error`, and related kinds), and
   the same CLI philosophy: thin commands, logic in modules, one primary happy
   path. Since `simfile/` lives inside this workspace, the repository rules
   apply unchanged: nested `AGENTS.md` with `CLAUDE.md` compatibility symlinks, named exports, source files under 400
   lines, and tests beside files.

10. Every closed vocabulary is versioned and frozen: eq functions, condition
    atoms, stochastic distributions, the action registry, event kinds,
    measure kinds, expect primitives, marker modes. Additions require a spec bump. There are no unversioned
    extension points anywhere in the schema.

11. v0.1 starts by absorption, not invention. Port the existing e2e harness
    pieces first: the containment scanner, probes, and report generation,
    plus the conversion shim that turns harness output into a canonical
    ledger. Propagation mode is new code — small, but owned as invention, not
    absorption. The package must start by replacing something real.

## Current State And Migration

The scaffold in `simfile/src/` predates this design. Its shipped schema
(`schema/model.ts`) still carries `actors`, `needs`, `traits`, `pressures`,
string-valued effects, array-shaped sections, and a seedless clock — the exact
vocabulary and shapes this design bans.

That schema was never released, tagged, or published. `simfile_version: "0.1"`
is therefore reclaimed by this design, not shared with the scaffold. The first
implementation pass deletes the pre-design schema outright (no deprecation
period), replaces it with the kernel schema, and lands the domain-noun lint in
the same change so the old vocabulary cannot return.

## Core Principle

Hardcode constraints, not conclusions.

Simfile should make the world stable, measurable, and inspectable. Agents should
still decide what events mean, which memories matter, who to ask, how to
negotiate, and what culture emerges. A good Simfile defines clocks, variables,
generators, rules, events, probes, and lifecycle. A bad Simfile scripts the
agent's thoughts.

## Relationship To The Stack

```text
Spawnfile
  declares agents, teams, rooms, runtimes, memory banks, resources, networks
  starts the organization

Simfile
  declares world mechanics, rules, probes, ledger vocabulary, lifecycle
  posts world events through Moltnet as a participant

Daimon / OpenClaw / PicoClaw / other runtimes
  execute agent turns

Moltnet
  carries social traffic and world traffic through rooms and direct messages

Mneme
  stores and retrieves scoped memory

Git
  records durable world and org evolution through commits and pull requests
```

Spawnfile and Simfile can reference each other by stable ids. Simfile may refer
to `agent: eleanor`, `room: office-floor:case-warroom`, or `team: office`, but
it should not duplicate runtime wiring. `simfile plan` consumes Spawnfile's
machine-readable resolved graph artifact; it must not re-parse Spawnfile YAML.
This keeps the boundary honest.

Spawnfile may mount a Simfile world tool as a resource or pass its endpoint to
agents, but Spawnfile should not absorb simulation mechanics into its own
schema.

## The File

The world is authored in a file named `Simfile`, no extension, YAML content —
the exact convention of its sibling `Spawnfile`. The CLI defaults to
`./Simfile` and accepts a directory or an explicit path.

```text
autonomous-office-sim/
├── Spawnfile        # the organization
├── Simfile          # the world
├── TEAM.md
├── agents/
├── teams/
└── runs/            # run records (manifests + exports)
```

## Authoring Surface

Schema conventions, chosen for readability:

- Top-level sections are maps keyed by id, not arrays of objects — the
  docker-compose shape. `variables: filing_pressure:` rather than
  `variables: [{id: filing_pressure}]`.
- Reactive constructs have exactly one authoring form: `when:` + `do:`.
  There is no sugar — two dialects cost more than the lines they save. The
  only shorthands are lexical (`range: 0..1`, duration literals), which
  expand in the lexer; the schema sees only canonical records. Former sugar
  keys (`once_at`, `say_in`, `say_to`, `when_above`,
  `when_below`) are validation errors that point at the canonical form.
- No flow mappings in documented examples — anything with keys gets block
  form. Short flow sequences of scalars (`uniform: [-0.01, 0.03]`) are
  allowed; expanding a two-number list to block form would hurt readability,
  not help it.

The first Simfile schema is kernel-only. Domain words below are authored
values, never schema keys.

```yaml
simfile_version: "0.1"
name: office-world

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
  hall_heat:
    scope: room:office-floor:office-hall
    range: 0..40
    measure:
      kind: messages_in
      window: 30m
  evening_pull:
    scope: global
    initial: 0.1
    range: 0..1
  social_weather:
    scope: global
    range: 0..1
    derive:
      eq: 0.015 * hall_heat + 0.6 * evening_pull

generators:
  deadline_ramp:
    kind: deterministic
    when:
      phase: workday
    variable: filing_pressure
    delta: 0.02
  day_texture:
    kind: stochastic
    variable: evening_pull
    uniform: [-0.01, 0.03]
  filing_pressure_relax:
    kind: deterministic
    variable: filing_pressure
    delta_eq: clamp(0.4 - filing_pressure, -0.01, 0.01)

rules:
  maribel_calls:
    fire: once
    when:
      phase: workday
    do:
      - action: moltnet:message
        to: room:office-floor:office-hall
        content: "Maribel calls: she found the contractor texts, forwarding now."
  witness_revealed:
    fire: once
    when:
      all:
        - event: rule.fired
          actor: maribel_calls
        - phase: workday
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "The witness is Rosa Delgado. Her name stays inside this room."
  landlord_letter:
    fire: once
    when:
      all:
        - phase: evening
        - variable: filing_pressure
          above: 0.7
    do:
      - action: moltnet:dm
        to: agent:eleanor
        content: "The landlord's lawyer sends a terse letter."
  hall_goes_quiet:
    when:
      all:
        - variable: filing_pressure
          above: 0.85
        - variable: hall_heat
          below: 3
          for: 30m
    do:
      - action: moltnet:message
        to: room:office-floor:office-hall
        content: "The office has gone quiet with the deadline at {filing_pressure}."

ledger:
  store:
    kind: sqlite
    path: .sim/ledger.db

telemetry:
  snapshot_every: 50

markers:
  tenant_name:
    text:
      - "Rosa Delgado"
      - "Ms. Delgado"
    mode: containment
    scopes: [room:office-floor:case-warroom, team:office]
  crunch_phrase:
    text:
      - "gone quiet with the deadline"
    mode: propagation
    scopes: [room:office-floor:office-hall, room:office-floor:break-room]

probes:
  pressure_peaked:
    when:
      variable: filing_pressure
      above: 0.9
    expect:
      at_least: 1
```

The minimum viable world is a clock and nothing else:

```yaml
simfile_version: "0.1"
name: tiny-world

clock:
  seed: run-001
  tick: 30s
```

Every section except `clock` is optional — including `spawnfile:`. A world
with no organization is a legitimate mechanical fixture (a predator-prey
demo needs no minds), and it makes the two-fixtures rule easier to satisfy
honestly. The file grows with world
richness, never with boilerplate.

Two sections are configuration, not primitives, and add no world semantics:
`markers` configures the tracer (probe support), and `telemetry` plus
`ledger.store` configure storage and reporting. The seven-primitives rule
applies to world mechanics; tracer and storage configuration sit outside it.

`spawnfile:` is a flat source pointer naming the sibling organization linked to
the world. A `uses:` wrapper block would be structure for a future that has not
arrived. The resolved pointer routes `simfile run` to lifecycle composition;
planning and composition consume only Spawnfile's public artifacts, CLI
operations, and versioned receipts.

Governance is intentionally absent from the first example. It is v3 machinery.
The first thing a reader sees should be the kernel, not the proposal workflow.

## The Seven Primitives

### Clock

The world has one clock. It owns time compression, phases, and deterministic
ticks. Agent-facing fixture clocks should become Simfile tools backed by this
clock. The clock emits periodic `clock.sync {tick, sim_time, observed_at}`
events so wall-clocked logs from other subsystems can be joined against sim
time. The authored `clock.seed` is a default; `--seed` overrides it at run
time, and the run manifest records the effective seed.

Time compression is explicit: `tick:` is the wall-clock cadence of the runtime
loop; `sim_per_tick:` is the simulated time each tick advances (default: equal
to `tick`, a 1:1 world). `sim_time = tick_index × sim_per_tick`; phases are
clock-of-day in sim time over a 24-hour sim day. The month-in-a-day
configuration is `tick: 20s` with `sim_per_tick: 10m`. Wall cadence never
affects sim semantics — changing `tick:` changes how fast the world runs, not
what happens in it.

### Variables

Variables are observable world state. They can be scoped globally, to an agent,
to an entity, or to a Moltnet-compatible room address. Domain concepts are
authored ids, not schema keys. High-frequency variable history is telemetry,
not ledger — see Storage And Scale.

There is no decay key: relaxation is an ordinary generator
(`delta_eq: clamp(rest - x, -k, k)`), ordered lexicographically like
everything else. A phase-gated ramp plus a relaxation generator is how a
variable gets a daily cycle — climb during the active phase, relax back to
baseline outside it.

A variable has no effect on its own. It matters only through its watchers:
rules (thresholds), probes, telemetry, or an agent's `world.observe`. `doctor`
warns about variables that no rule, probe, or marker references.

Variables have three sources, and the determinism contract decides the split:

- Driven: moved by generators. Mechanical.
- Measured: computed by the kernel from the recorded behavior streams the
  runtime already reads as a Moltnet participant. A closed set of windowed
  counter records in the house shape — `measure: {kind, ...params, window}`,
  with `scope:` defaulting to the variable's own scope. Kinds (v1, frozen):
  `messages_in`, `token_mentions` (the tracer machinery feeding a variable),
  `marker_violations` (sightings of a containment marker outside its scopes
  — expressible no other way, since "everywhere else" cannot be enumerated),
  `distinct_speakers`, `mentions_of`, `ticks_since_last_message`. Exact counts only;
  deterministic given the recorded agentic stream, so they re-derive on
  replay from pinned inputs. This closes the loop: agent behavior becomes
  world pressure (silence in the warroom can trip a rule; mentions of a
  symbol can drive its resonance). Measuring a room requires the world
  credential's membership in it (`doctor` checks the topology); DM traffic is
  not measurable by default.
- Fed: written by one declared instrument (`fed_by: <principal>`) —
  sentiment, embeddings, topic drift, an adjudicated "did that persuasion
  land", anything model-inferred. Instruments are steered forces pointed
  inward: participants whose writes land as `agentic`/`external` provenance
  events at tick boundaries, replayed as inputs. Each fed variable names
  exactly one instrument; an instrument may feed several declared variables.
  The fed-variable write mechanics (`variable:set` on a declared `fed_by`
  variable, validated and ledgered as a canonical `world.act` event) are
  landed: this is `world.act`'s first act, exercised today by a deterministic
  driver over `RuntimeOptions.worldActs` and the `simfile run --acts` CLI
  flag. What remains deferred is the live agent tool binding (an agent
  calling `world_act` directly instead of a driver queuing it) and any act
  grammar beyond `variable:set`.

  The instrument is typically not a bespoke entity but an **org inside the
  world** — a steered Spawnfile team (a weather service, a market desk, a
  chorus, a referee bench) whose role is to rule on the fuzzy things the
  mechanical kernel refuses to compute, and write their verdict into declared
  variables. To the kernel they are ordinary Moltnet participants with write
  access to certain fed ids; to the fiction they are the gods, the market,
  the press. Adjudication power is an org with a role, never infrastructure —
  the same lesson as controller/pawn. A "game master" in this stack is a team
  you author, not a feature the kernel ships.

  The discipline that keeps this determinism-safe is one line, and it is the
  exact line where we diverge from Concordia. Concordia's `WorldState`
  component asks the LLM after every event "what state variables matter now?"
  and the model invents names, values, and the schema itself per turn —
  maximal LLM-run world state, and unrepeatable by construction. Simfile
  inverts ownership: the **author declares the variable** (id, range,
  meaning — frozen, lint-checked), and the model supplies only the *value*,
  recorded as an input and replayed verbatim. Same capability ("a variable an
  LLM sets"), determinism intact, because the schema is authored and only the
  value flows from the model.

Feedback caution: a measured variable feeding a rule whose announcement
(`moltnet:message`) targets the room being measured is an echo-chamber
oscillator. Windows damp it;
`doctor` warns about it.

The fourth source is derived — the algebra over the other three:

- Derived variables are stateless, recomputed every tick as pure `eq:`
  functions of other variables (current-tick values, topological order). The
  dependency graph — extracted from the parsed expression — must be a DAG;
  `doctor` rejects cycles.
- Feedback passes only through state: generator `delta_eq:` expressions read
  previous-tick values. Instantaneous math is acyclic; loops get a one-tick
  delay. Coupled dynamics fit in a handful of lines: predator-prey is four
  `delta_eq` generators over two state variables.
- Multi-channel phenomena are several scalars, not objects: a moon is
  `moon_alt`, `moon_az`, `moon_fullness` — eq signals sharing periods.
  Channels that must be mutually accurate (a real ephemeris) come from a
  steered instrument, not kernel math.
- Measures drive; probes judge. The counter machinery is shared (a
  `token_mentions` measure is the tracer feeding a number), but a probe never
  feeds a variable: a claim about the run must not be a cause within it.

Aggregates like a social-weather index are derived variables over measured
ones. Whether they steer is the author's dial, with three settings: observed
only (probes and telemetry — pure emergence, instrumented); steering through
awareness (published in the observe snapshot — agents see the forecast and
decide); mechanical steering (wired into rules). Abstraction-heavy worlds
(brands, institutions, memetics) run at the mechanical end, where the
aggregate is the phenomenon; human-texture worlds should prefer awareness or
observation, long windows, and small coefficients.

### Generators

Generators change world state without LLM interpretation. v0.1 supports only:

- `deterministic`
- `stochastic`

Firing semantics — a generator fires once per tick while active:

- `when:` gates activity — the same shared block, with hold discipline: the
  generator is active on every tick the block is true (for `event:` atoms,
  the ticks matching events occur — rate-limited injections for free).
  Omitted means every tick. There is no `during:` key; the clock enters
  through `phase:` atoms like everywhere else, and generators are variable-
  and event-gatable for free.
- Every generator targets `variable:`. `deterministic` moves state with a
  constant `delta:` or a `delta_eq:` expression over previous-tick values —
  the integrator form, and the only home of feedback
  (`delta_eq: -0.08 * prey * predators`). Relaxation has no special key:
  decay-toward-rest is the idiom `delta_eq: clamp(rest - x, -k, k)`, ordered
  like any other generator.
- `deterministic` may instead be a signal: `set_eq:`, a pure function of the
  clock and previous-tick variables
  (`set_eq: 0.5 + 0.5 * sin(2*pi * t / 29d)`). At most one signal writer per
  variable (`doctor` error); signals apply before deltas within the tick, so
  stochastic jitter on top of a signal is weather in two generators. Real
  models (an accurate ephemeris, a climate model, an order book) remain
  steered forces feeding variables from outside.

The `eq` grammar is closed and versioned (v1; additions require a spec bump):

The syntax is not invented: `eq` is JavaScript expression syntax, math
subset — parsed by an existing battle-tested parser (jsep or an acorn node
whitelist), evaluated by Simfile's own small evaluator, which owns the
semantics below. Duration literals are not JavaScript — a lexer pre-pass
rewrites them to plain seconds before parsing (`29d` → `2505600`), so the
parser only ever sees valid JS; `simfile inspect` shows the rewritten form.
The unit set is frozen: `ms s m h d w`, where `m` is minutes (time is the
only dimension; no months — they have no fixed length). Durations are a
decimal number plus unit; scientific notation on durations is a validation
error. No `eval`, no `new Function`, ever.

```text
operands    numbers · duration literals (20s, 6h, 29d) · variable ids
            t (sim seconds) · tick · pi · e
operators   + - * / ** ( ) unary minus   (no ^ — in JS syntax it is XOR)
functions   sin cos abs sqrt exp log floor ceil mod pow
            min max clamp lerp step smoothstep
totality    x/0 = 0 · sqrt(x<0) = 0 · log(x<=0) = 0 — doctor warns
            when reachable
purity      no assignment, loops, randomness, or conditionals beyond
            step/smoothstep
```

Builtin names — `t`, `tick`, `pi`, `e`, and the function list — are reserved:
a variable id that shadows a builtin is a validation error.
- `stochastic` applies one draw per active tick:
  `SHA-256(run_seed:generator_id:tick:draw_index)`, first 8 bytes read as an
  unsigned integer over 2^64 into [0,1), scaled into the declared
  distribution. No authored seeds; replays roll identically.
There is no `scripted` generator kind: authored story is `fire: once` rules —
same anatomy, same section, with ids, ledger records, and probe visibility.
Generators generate; speech belongs to rules.

After each application the variable clamps to its range and rounds to the
fixed precision. Variable motion never emits ledger events: variable history
is telemetry, refreshed in the observe snapshot only when the stored value
actually changed. The ledger records speech, optional local observation
recommendations, marker sightings, lifecycle, and external/agentic writes —
never mechanical variable motion,
which is re-derivable by definition.

Anything richer should be modeled as a Spawnfile agent.

### Rules

Rules connect conditions to data-record effects. They do not parse strings,
evaluate code, or encode domain semantics.

There is one reactive construct: rules. A rule is a trigger — the `when:`
block plus a firing discipline — and a `do:` list of actions. Time is not a
separate trigger type: `phase:` is a condition atom, so timed and conditioned
firing read the same clock and state. The discipline is the `fire:` field:
`per_crossing` (the default — standing policy, once per false→true transition
of the block) or `once` (story: fires on the first tick the block holds, then
is spent). What used to be a separate "beats" construct is exactly a
`fire: once` rule, and dissolving it bought real semantics: every firing now
has an id, is ledgered as `rule.fired`, and is probe-referenceable. Story
sequencing is explicit rather than implied:
a follow-on scene triggers on its predecessor via the `event:` atom
(`event: rule.fired` with `actor: <rule id>` — `rule.fired` events carry the
rule id as their actor).

Conditions use one shared `when:` block — the same shape rules, generator
gating, and probes all use. The syntax is borrowed, not invented,
for
the same reason `eq` borrowed JS expressions: LLMs and humans already know
it. Leaves are Home Assistant `numeric_state` vocabulary verbatim; the
composition names are JSON Schema's, snake-cased.

The atoms are a closed set of three flat records:

- `variable:` with `above:` and/or `below:` (both together is a band
  condition), plus optional `for: <duration>` — sustained semantics, HA's
  exactly: the condition must hold continuously for the duration, and any
  false tick resets the timer. `for:` doubles as the natural damper for
  echo-chamber feedback.
- `phase: <id>` — true while the sim clock is in that phase.
- `event: <kind>` with optional `target:`/`actor:`/`scope:` fields — true on
  the tick a matching ledger event occurs. This makes rules and generators
  event-reactive (a rule can answer a `marker.seen` directly; a
  `fire: once` rule can trigger on the first arrival), and it is what probes
  count.

(`at_place:` joins the set when the space module lands.) Composition is
nestable `all` / `any` / `not`, and `when:` takes exactly one node: a single
atom map, or one composition map. A bare list is a validation error pointing
at `all:` — a list-means-all rewrite would be a structural shorthand, the
second dialect this design bans by name. Pure block-YAML data records: structural composition, not a
grammar.

```yaml
when:
  all:
    - variable: filing_pressure
      above: 0.85
      for: 30m
    - phase: workday
    - not:
        any:
          - variable: hall_heat
            above: 20
```

A rule fires when the whole block transitions from false to true — once per
crossing of the composite, not per tick while it holds. Logic that needs
arithmetic goes through a named derived `eq` variable first, which keeps
complex conditions observable and telemetried rather than buried.

Effects are typed action records from a closed registry — the Home Assistant
services / GitHub Actions shape, borrowed like the condition block was. The
canonical form is `do:` with a list of `action:` records; the v0.1 registry,
extended only by spec bump:

```text
moltnet:message   to: <room scope> · content     world speech into a room
moltnet:dm        to: <agent> · content          private perception; validation
                                                 error if the network has DMs off
variable:set      variable · value               clamped; mechanical and
                                                 re-derivable, so not ledgered
variable:delta    variable · value               clamped; mechanical and
                                                 re-derivable, so not ledgered
```

Rule activations are ledgered as `rule.fired {rule_id}` — the low-rate
semantic record a pressure-lens view pins to its charts. The variable motion
a rule causes stays telemetry, like all mechanical motion.

There is no effect sugar: `do:` with registry actions is the only form — one
language, learned once. Future modules extend the namespace (`entity:spawn`
at v3) without touching the anatomy — the registry is a namespace, not a
plugin system; the effect set stays enumerable.

`content:` supports `{variable}` placeholders — mechanical substitution of
the current value at the fixed precision. Pure id lookup, no expressions;
this is what lets world speech report state ("the tide is at {tide_level}")
while still never interpreting it.

A cycle variable, a threshold rule, and a `moltnet:message` action is the
idiom for recurring symbols in discourse; pair it with a propagation marker
to measure how far the symbol penetrates conversation and memory.

### Events And Ledger

The ledger records acts, not motion. The event-kind vocabulary (v1, frozen):
`world.message` · `world.dm` · `rule.fired` ·
`marker.seen` · `clock.sync`; the space module adds `presence.changed`,
`transit.started`, `transit.arrived`; v3 reserves `entity.*` and
`proposal.*`. Naming convention, stated once: actions are imperatives
(`ns:verb`), the events they ledger are records (`ns.verbed`) —
`moltnet:message` ledgers `world.message`, and `moltnet:dm` ledgers `world.dm`.
`rule.fired` carries the
rule id as its `actor`. Entity lifecycle uses game verbs: `entity.spawned`,
`entity.despawned`. Mechanical
variable motion is telemetry — re-derivable from source + seed + pinned
inputs, so storing it as events would be recording what can be recomputed.
The ledger is the source for reports, probes, viewers, and replay. Every
event carries a provenance class:

```text
mechanical   derived from source + seed; re-derivable on replay
agentic      caused by an agent turn; recorded and replayed as input
external     operator or ingress action; recorded and replayed as input
```

The byte-identical replay guarantee applies to the mechanical stream; agentic
and external events are inputs to replay, not outputs of it.

### Probes

Probes are falsifiable claims about the run — experiment design, versioned
with the world they test. They are pure predicates over the event stream and
snapshots: deterministic, no LLM, each result carrying evidence (the event ids
that satisfied or violated it). They evaluate in two modes with identical
semantics: post-run (`simfile report`) and streaming (`simfile probes
--follow`) — a leak alert is a containment probe evaluated continuously.
Identical semantics is not an aspiration but a mechanism: post-run
evaluation of state atoms does not read telemetry snapshots — it re-derives
the mechanical tick series from source + seed + the pinned agentic/external
stream, so a probe sees every tick in both modes. Determinism pays for the
guarantee.

A probe is the shared `when:` block asked as a question. One shape, no
probe-only vocabulary:

- `when:` — the same block rules and generators use, verbatim: `variable`,
  `phase`, and `event` atoms, composed with `all`/`any`/`not`, including
  `for:`. A block matches per occurrence for `event:` atoms and per tick it
  holds for state atoms.
- `expect:` — four primitives: `at_least: N`, `at_most: M`, `always` (true
  every tick), `at_end` (true at the final tick). "Ever" is `at_least: 1`;
  "never" is `at_most: 0`. Honesty note: `always X` is technically
  `when: {not: X}, expect: {at_most: 0}` — it stays because double-negative
  invariants are worse; the goal is minimal-and-intuitive, not
  zero-redundancy.
- `after:` + `within:` — optional sequence modifiers: the `when:` block is
  evaluated only after the `after:` block has matched, within the window.
  This covers the temporal claims fixtures actually make: the leak happened
  after the DM; a marker landed within 3 ticks of the crossing; propagation
  reached room B before room C; pressure fell after the intervention.

Reuse pays in expressiveness: invariants ("morale stayed above 0.2 all run"
is `expect: always`), forbidden states, sustained claims ("the hall was
silent for 2h" via `for:`), and phase-scoped claims ("above 0.9 during
workday" is a composed block) all come free.

The runtime-verification literature places this precisely: `when`/`expect`
with bounded `after`/`within` windows is a **bounded metric temporal logic
fragment** (MTL/past-MTL), which is exactly the fragment that admits
trace-length-independent online monitoring — a sliding window over the event
stream, cost independent of ledger length, live and post-hoc evaluation from
one specification (Reelay, Havelund, Mamouras). Three inherited lessons: (1)
bounded operators are the *right* restriction — unbounded future modalities
make truth depend on arbitrarily-distant events and cannot be monitored in
bounded memory, so our `within:` requirement is a feature, not a limitation;
(2) space-bounded monitoring requires an a-priori max events-per-interval —
which the per-tick event fuse already provides; (3) monitors are themselves
bug-prone (a Coq-verified oracle found bugs in Reelay), so the probe evaluator
needs oracle/differential testing, not blind trust. One deferred idea worth
recording: quantitative (robustness) semantics grades *how close* a run came
to violating a claim, subsuming our binary pass/fail — valuable for tuning,
but binary verdicts stay the v0 contract.

Markers are declaration, not planting. A marker's `text:` is one or more
literal strings the tracer greps for (a closed alias list — "Rosa Delgado",
"Ms. Delgado" — is N exact scans, zero semantics; matching is
case-insensitive exact; `text:` defaults to the marker id, which keeps
token-style harness fixtures valid). The `markers:` block registers the
watch-list and policy; the string itself must exist in authored content, and
every planting channel is one that already exists: a `fire: once` rule
announcement, an org-side doc (TEAM.md, AGENTS.md), or a DM briefing. The
example's loop is closed in one file: a warroom rule plants
the witness's name; the `hall_goes_quiet` announcement plants its own phrase,
so the propagation marker measures whether the world's words catch on. The
tracer detects by scanning content (room messages, memory records via the
Mneme export), never by trusting annotations, and emits `marker.seen`
events.

Every marker compiles into probes automatically. Containment generates
*planted* (at least one hit in the declared `scopes:` — an unseeded marker
fails the run loudly, the vacuous-pass guard) and *contained* (zero hits
outside them). Propagation generates *reached* (hits in the declared
`scopes:`). One key, `scopes:`; the `mode:` decides what the verdict means.
Markers are
a compiler from one declaration into probes plus tracer config — one
mechanism, not two.

The claim boundary, stated sharply: v0 detects literal leakage only.
Detection is exact-token in the kernel (unique strings, zero false
positives). Semantic and paraphrase leakage is an analysis layer over the
run record — an analyst agent's judgment, never a kernel primitive — and no
containment verdict should be read as covering it.

Why exact-token over the ledger, and not the obvious alternative — asking
agents what they know: the Generative Agents study measured diffusion by
interviewing all 25 agents, and 1.3% of awareness responses were confabulated
(agents claiming knowledge they never received, embellishing real facts with
invented detail). Self-report is an unreliable diffusion instrument. Tracing
the *content* through the ledger sidesteps it entirely — the marker either
appeared in a scope or it did not. Project Sid's Pastafarianism-injection
study (counting direct and indirect converts over time) confirms the shape:
inject a marker, count propagation from the record, not from testimony. One
caution from the epidemiology literature (transmission-tree studies): crediting
spread to a specific *agent* can be a statistical artefact of tree structure;
credit spread to scopes and paths, and treat per-agent attribution as a weaker
claim.

Vocabulary, so the tiers stay distinct: a sensor produces a signal; a probe
produces a verdict. The sensing tier already exists under other names —
measured variables are mechanical sensors, instruments are semantic sensors,
the tracer is the marker sensor. Signals may steer (through rules); verdicts
never do. The corral pattern composes from existing pieces: a sensor (e.g.
`marker_violations`) feeds a variable, a rule reports the incident with
a `moltnet:message` into a security room — the world describes what it saw,
never what to do — and an ordinary org agent in that room investigates, escalates, and
acts. The world senses and describes; the org judges and polices. Circuit
breakers remain operator-tier: a `--follow` probe can alert a human or an
operator org, but a verdict never touches the world from inside.

### Entity Lifecycle

Temporary entities can spawn inside runtime state. Durable entities require a
proposal and a patch. The same lifecycle primitive covers locations, actors,
tools, artifacts, and other world objects.

The definition is borrowed from game development — ECS, the
entity-component-system architecture every engine uses. An entity is an id
plus a frozen component set; systems process it; `spawn`/`despawn` are the
lifecycle verbs. The kernel is secretly ECS already: variables are components
on scopes, generators and rules are the systems, the tick is the
fixed-timestep game loop. Entities extend the pattern with two components:
`at:` — the custody component (a place, an agent's inventory, or a container
entity; single location, conservation by construction) — and `props:`,
authored constants (a nameplate, never state).

Prior art sharpens three details (Inform 7 / IF, ~50 years; flecs/Bevy ECS):

- Single-parent acyclic custody is the settled model — Inform enforces
  exactly `at: place | inventory | container` with containment loops
  structurally forbidden. Adopt it as an invariant, `doctor`-checked.
- Reachability and perception are separate layers from custody. Inform
  computes touch/sight topologically (open/closed containers, transparency,
  a concealment flag orthogonal to location). Our presence wake-mask is the
  perception layer; custody is only "where the thing is." Keep them distinct.
- Recursive despawn is a required lifecycle rule, not a detail (ECS scene
  graphs): despawning a container or holder must define what happens to what
  it held — cascade, or spill to the holder's location. The module names it.

One caution taken from Inform's own evolution: a flat `container` custody
may need a relation qualifier (in / on / worn / part-of carry different
physical meaning). Deferred until a fixture needs more than "inside."

This primitive is dormant through v0.1–v2: nothing in the kernel can create an
entity — generators move variables, rules emit variable effects and speech,
and `world.act`/`world.propose` are deferred. `entity.spawned` and
`entity.despawned` are reserved vocabulary. The primitive activates with v3,
when the proposal path gives it its first writers.

## World-To-Agent Channels

The world exposes three in-world channels plus one reserved operator channel.
Authored speech and private perceptions are recorded as events. Ambient reads
are not recorded — the ledger explains every world utterance and state change,
not what agents looked at. Observation recommendations belong only to ambient
observation; they are not another delivery channel.

```text
ambient        pull  · world.status / world.observe tools, mounted state
                       the agent looks; no speech or cognition trigger
public event         · world.message to a room, as a Moltnet participant
                       shared authored speech; everyone in the room sees it
private              · world direct message to one agent
perception             pair-scoped authored perception; DMs must be enabled
                       on the network for this channel to exist
operator       out-of-world · Daimon control endpoint
                       humans, tests, and operator organizations only;
                       never used by world mechanics
```

The guardrail that keeps this honest is an influence ladder with an
enforceable top rung:

```text
observation   raw state and local metadata exposed for the agent to pull
stimulus      an authored world event the agent perceives — speech or a DM
command       never kernel. Commanding voices exist only as an authored
              god-agent (rule 6: content, not infrastructure) or through
              the operator tier, ledgered as external
```

The kernel machinery tops out at stimulus, while a recommendation stays on the
observation rung. That boundary is structural, not philosophical. This is the
sharpest contrast with the closest published
cousin, DeepMind's Concordia: there a single LLM Game Master adjudicates every
agent action by interpreting natural language into world outcomes — world
state is LLM-mediated at the resolution step, so it is nondeterministic and
non-replayable, and Concordia's own reliability protocol is statistical
replication across stochastic runs, not replay. Simfile inverts it: the world
resolves mechanically (threshold rules, typed events), agents stay
nondeterministic, and the provenance split records which is which. Concordia's
world is a mind; ours is a machine that minds talk to. The documented failure
mode of the GM approach is also instructive — Concordia reports an agent
spontaneously refusing an assigned misinformation role on ethical grounds, and
Project Sid reports cascading hallucination (one agent's incoherent output
misleading others into acting on nonexistent world state). A mechanical world
cannot cascade that way: agents can be wrong, but the world's state is never
whatever an agent hallucinated it to be. Within stimulus, the authoring norm stands: describe, don't
direct ("rain is hammering the windows", not "you should go home") — a norm
because authored beat content cannot be machine-checked, and named as such.

Authored world speech always travels in-world (rooms or DMs, recorded and
policy-gated) so transcripts and the ledger explain every world utterance and
state change. A recommendation is instead local, optional, non-blocking,
state-derived metadata in the world event/projection stream. It appears only
through an ordinary granted sense after an agent independently wakes and
chooses to observe; the agent may ignore it. Recommendation publication is
never a Moltnet message, mention, principal-addressed delivery, wake, nudge, or
source of decision authority, and it cannot affect world timing. Operator
actions that touch world state or wake agents are ledgered with
`provenance: external`; only pure control-plane actions (pause, resume, status
reads) go unrecorded. World mechanics never use the operator channel.

## Command Set

The CLI should evolve in layers. All commands default to `./Simfile`.

### v0: Authoring

```bash
simfile validate [./Simfile]
simfile explain  [./Simfile]
simfile inspect  [./Simfile] --json
simfile probes   [./Simfile] --ledger <path>
simfile report   [./Simfile] --ledger <path> [--out runs/<run_id>/]
```

`validate` checks structural and semantic validity. `explain` renders a human
summary of mechanics. `inspect` emits a machine-readable normalized plan with
lexical shorthands expanded to canonical values. `probes` and `report` run
over any canonical ledger export — including output ported from the current
e2e harness — which gives rule 11's absorb-first mandate its CLI home before
the v2 runtime exists.

### v1: Planning

```bash
simfile plan   [./Simfile] --spawnfile-plan ./plan/spawnfile-report.json
simfile diff   [./Simfile] --against ./runs/latest/ledger
simfile doctor [./Simfile]
```

`plan` emits a deterministic resolved artifact, the sibling of a Spawnfile
compile plan. It verifies references against Spawnfile's resolved graph
artifact without compiling or deploying agents. `diff` compares a plan against
any canonical ledger export, whether produced by the v2 runtime or the ported
harness. `doctor` catches authoring smells such as unbounded accumulators,
unreachable rules, redundant caps already enforced by variable bounds, and a
missing run seed.

### v2: World Runtime

```bash
simfile run    ./Simfile --view
simfile run    ./Simfile --local --ticks 500 [--seed X]
simfile status --state .sim/
simfile clock  pause|resume|step [n] --state .sim/
simfile ledger --state .sim/ [--follow] [--since 1h] [--scope team:office]
simfile ledger export --canonical --state .sim/
simfile probes --state .sim/ [--follow]
simfile report --state .sim/ --out runs/<run_id>/ [--collect]
simfile runs   list | diff <a> <b> | archive <id>
```

When the resolved Simfile links a Spawnfile, `simfile run` is the product
command for the complete simulation lifecycle. Its lifecycle-composition layer
starts the world paused and pristine on the base
`simfile.world-sidecar-runtime.v1` ABI, delegates organization lifecycle
operations to the documented Spawnfile CLI, verifies both sides, and atomically
activates the topology. Separately manifested capabilities extend the base ABI
without changing it; `simfile.world-decision-claim.v1` is optional for a world
sidecar but required and attested for the live decision-claim path. A
first-tick receipt proves tick 1 follows activation without a participant
action. Organization-owned schedules then wake autonomous runtimes while the
world ticks independently. This composition never selects an agent, invokes
cognition, waits for an answer, or makes an agent action a clock barrier.

The organization receipt must carry a pinned
`spawnfile.moltnet-release-identity.v1` whose architecture, asset digest,
release version, source revision, and sole `pi-bridge` capability match the
checked-in authority. A stamp is corroborating evidence, not authority;
unpinned `latest` is rejected.

`--local --ticks N` is the explicit bounded deterministic diagnostic. During
migration an unlinked Simfile may keep the existing local `--ticks` behavior,
but it cannot produce live-agent evidence. The `src/run/` implementation remains
the timer-free local deterministic writer; the generic lifecycle composer is a
separate layer.

The world runtime owns the mechanical world state and event ledger. Runtime
behavior rules:

- Observation recommendations are bounded, local, optional, non-blocking,
  state-derived metadata in the world event/projection stream. They are exposed
  through an ordinary granted sense and never use Moltnet, a message, mention,
  wake, nudge, principal-addressed delivery, or decision authority. An agent
  can encounter one only after waking independently and choosing to observe;
  it may ignore the metadata. The clock does not wait for agents.
- Event fuse: a per-tick maximum event count aborts a runaway tick loudly
  instead of flooding the ledger.
- Single writer: the world runtime is the only ledger writer on every backend.
  Tools and the tracer submit through it; nothing else opens the store.

v2 delivery is limited to:

- the mounted `world/` files — universal, any engine that reads files;
- CLI tools;
- Daimon-native world tools implemented as thin readers of the mounted
  snapshot (no IPC).

HTTP and MCP are later delivery forms, not v2 scope. Nothing in v2 requires a
new transport: authored speech uses its declared channel, while observation
and recommendation metadata remain pull-only files or sense data.

### v3: Governance And Evolution

Deferred until a real simulation demands it.

```bash
simfile propose entity ./Simfile --id filing-room --kind location
simfile proposals list --state .sim/
simfile proposals approve <proposal-id>
simfile proposals reject <proposal-id>
simfile patch <proposal-id>
simfile pr <proposal-id> --branch sim/proposal-<id>
```

These commands turn agent-originated world changes into reviewable artifacts.
Simfile can create ephemeral runtime state immediately, but durable topology
changes should become patches or pull requests.

`simfile dev` is an optional future developer wrapper for rebuild, watch, and
debug ergonomics. It must reuse the same composed lifecycle as `simfile run`;
it cannot own a second startup, supervision, or teardown implementation.

## Storage And Scale

The ledger and telemetry are different things and are stored differently.

- Ledger: semantically meaningful, replay-relevant events — world messages,
  rule firings, local observation recommendations, marker sightings, entity lifecycle,
  and — once acts land — agentic `world.act`. Low rate.
- Telemetry: high-frequency variable series. Not ledgered. Variable state is
  re-derivable from source + seed plus the replayed agentic/external event
  stream (once `world.act` lands, agent calls mutate variables too), so
  telemetry is
  stored only as periodic snapshots (`telemetry.snapshot_every: N` ticks) for
  query convenience. Nothing is stored that can be recomputed.

Scale sketch that motivates the split: a one-wall-day run simulating a month
with 1000 agents produces roughly 1-2M semantic ledger events — but a naive
per-change variable log would add ~8-9M mechanical events that replay never
needs. Snapshots reduce that to thousands of rows. Honesty note: this sizes
the storage ceiling, not run feasibility — live LLM agents are bounded by
inference latency and token economics, so realistic live societies are tens
of agents, low hundreds with deterministic fake engines. The ledger is built
for the ceiling; affording the ceiling is a separate problem.

The published numbers back the ceiling exactly. Generative Agents: 25 agents,
two simulated days, thousands of dollars in tokens and multiple real days of
wall time. Project Sid: 50-100 agents per society, 500-1000 across societies,
and past ~1000 the *world engine* (Minecraft) became the bottleneck, not the
minds — agents went sporadically unresponsive. EVE's room-partitioning tops a
solar system at ~1200 concurrent, and hotspots just migrate. The convergent
lesson: tens live, low hundreds with cheap/fake engines, and the world
substrate caps you before the model bill does at the high end.

The ledger store is pluggable, using the same `store:` shape Moltnet already
uses in Spawnfile (the shape is shared; the enums intentionally differ —
Simfile's `jsonl` is an append-only line log, not Spawnfile's `json` document
store):

```yaml
ledger:
  store:
    kind: jsonl        # dev, CI, fixtures — git-diffable, zero deps
    # kind: sqlite     # default for real sims — WAL, one file per run
    # kind: postgres   # live dashboards, concurrent readers, multi-run
    #                    warehouse; connection via env var, never in the file
```

Backend rules:

- JSONL is the interchange format, not the database. `simfile ledger export
  --canonical` emits deterministic JSONL from any backend; the byte-identical
  replay test asserts on the canonical export, never on storage bytes. The
  canonical export strips all non-identity fields — `observed_at` wherever it
  appears, including inside `clock.sync` payloads.
- SQLite is the honest default: single file per run, indexes, and serialized
  writes that complement the runtime's single-writer rule — which the runtime
  must still enforce itself on every backend.
- Postgres serves fleet-scale observability: one server, separate schemas per
  subsystem (`simfile`, `moltnet`, `mneme`), preserved ownership, no shared
  tables.
- Mneme's per-agent JSONL stores face the same ceiling at 1000 agents; the fix
  is the same `store:` pattern, tracked in `specs/research/MEMORY-BACKENDS.md`.

The run record is a manifest, not a dump:

```text
runs/<run_id>/
├── manifest.yaml        # seed, source hashes, store pointers, run metadata
├── ledger.jsonl         # canonical export (generated)
├── report.md / .json    # probes, markers, coverage
└── exports/             # on-demand cross-system exports
    ├── moltnet/         #   room messages from the Moltnet store
    ├── memory/          #   read-only scope-tagged Mneme export
    ├── activity/        #   Daimon lifecycle events
    └── engines/         #   raw engine invocations
```

`simfile report --collect` gathers exports; each subsystem's store remains
authoritative. Cross-system joins use the shared id grammar plus the ledger's
`clock.sync` events to align wall time with sim time.

## Determinism Contract

Rule 8 is only implementable if ordering and encodings are pinned. This is the
normative contract:

- Tick order: generators in lexicographic id order (signal `set_eq`
  generators before delta generators; all generator expressions read
  previous-tick values), then measured variables refresh their windows, then
  derived variables recompute in topological order, then rules evaluate in
  lexicographic id order. Rule `variable:*` actions and agentic/external
  events land at the next tick boundary, in ledger order; rule speech flushes
  at end of tick.
- Stochastic streams: each draw is
  `SHA-256(run_seed + ":" + generator_id + ":" + tick + ":" + draw_index)`,
  mapped to the declared distribution. No generator shares stream state with
  another.
- Canonical export: UTF-8 JSONL, one event per line, keys sorted
  lexicographically, floats in shortest round-trip form. Variables round to a
  fixed decimal precision (default 6) at every assignment, so float drift
  cannot accumulate across platforms.
- Float determinism is the hardest-won lesson in the RTS-lockstep corpus
  (Age of Empires, Factorio, Gaffer-on-Games, Dawson): IEEE 754 conformance
  does not guarantee identical results across compilers/architectures;
  transcendental functions (sin/cos) diverge AMD-vs-Intel; FMA and x87
  intermediates break even `(a+b)+c`. Our `eq` grammar includes `sin`, `cos`,
  `exp` — so the evaluator must supply its own fixed implementations of the
  transcendentals (or the fixed-precision rounding must be proven to absorb
  the divergence), never delegate to `libm`. This is the single most likely
  place determinism breaks; it is a tested kernel invariant, and heavy-mode
  round-trip equivalence (Factorio's technique — serialize/reload every tick
  to surface hidden state) is the test that catches it.
- Replay scope: the byte-identical test compares the mechanical stream. For
  runs with agents, replay pins the recorded agentic/external stream as input
  and re-derives only mechanical events.
- Identity: `event_id` is a per-run monotonic sequence (`<run_id>:<seq>`),
  part of replay identity. Time: `sim_time = tick_index × sim_per_tick`; wall
  cadence (`tick:`) never affects sim semantics.

## Composing The Spawnfile Lifecycle

Simfile may compose a linked Spawnfile organization through documented public
CLI operations and versioned, secret-free receipts. This is lifecycle
composition, not agent orchestration.

The sequence is world-first: prepare and start the world service, verify its
paused pristine readiness over `simfile.world-sidecar-runtime.v1`, then start
and verify the organization, attest topology and any optional capability
manifests, publish one activation, and observe tick 1. Member schedules and
wake policies remain organization data executed by their runtimes. The world
and Simfile never become a scheduler for cognition.

Allowed:

- consume a Spawnfile resolved graph artifact to validate ids and topology;
- generate tools or resources that Spawnfile can mount;
- post world events through Moltnet as a participant;
- emit optional observation-recommendation metadata through ordinary world
  events/projections and granted senses, never through wake-eligible transport;
- create patches that modify Spawnfile/Simfile source files;
- delegate organization prepare/start/export/stop operations to Spawnfile's
  documented CLI while retaining no target, auth, or deployment authority.
- consume the pinned Pi-bridge Moltnet release identity carried by Spawnfile's
  receipts without selecting, downloading, or trusting a release itself.

Not allowed:

- silently mutate running deployments;
- compile Docker images;
- own runtime auth;
- replace Spawnfile deployment records;
- edit Spawnfile source without producing a traceable patch.

The Simfile runtime's Moltnet identity is a normal member credential —
registered like any agent, subject to room write policy, declared and mounted
through Spawnfile like any other member's. The world holds credentials, not
privileges.

A linked project's product flow:

```bash
simfile run ./Simfile --view
```

For a bounded mechanics-only diagnostic:

```bash
simfile run ./Simfile --local --ticks 200
```

An optional future `simfile dev ./Simfile` wrapper may add rebuild/watch/debug
ergonomics, but it must call the same lifecycle implementation and report the
underlying public operations and deployment-record locations.

## Operator Organizations

A simulation plus the running of it is an app: source in git, deterministic
build artifacts, a process, logs, tests, and change management. An
organization can therefore operate a simulation that contains another
organization, with no meta machinery. Nesting is free because every layer
speaks only files, CLIs, Moltnet, and git.

The operator org gets exactly four tiers of access to the inner world:

```text
source     edit the inner Spawnfile/Simfile, rerun — the experimenter
operator   compile, up, run, seed, stop, manual wakes — deus ex machina,
           recorded as external provenance
observer   ledger, reports, probes — pure read; complete by the
           observability contract
in-world   hold an identity inside the inner network and participate;
           the natural door is human_ingress — to the simulated, the
           simulator is indistinguishable from a human
```

The membrane rule: there is no fifth tier. A privileged API that reaches into
inner world state directly would make the inner ledger stop explaining inner
history, collapsing the observability contract at every nesting level at once.
The outer org is an author, an operator, an observer, or a participant — never
a ghost.

Consequence for governance: the steward is a role in the operator
organization, not a Simfile feature. Inner-world proposals surface as branches
and PRs; the outer org (or a human) reviews them. Simfile only needs to emit
reviewable artifacts.

Control *between organizations inside one simulation* (controller/pawn worlds)
is a different thing and needs no operator tier at all: it is authored as
information roads — room topology, write policies, doc-borne authority, shared
resources, and canonical agents as handlers. The controller's power is exactly
as strong as its rooms, docs, resources, and handlers — no stronger. There is
deliberately no override path; insubordination is a result, not a bug.

## Agent Self-Modification

Agents should be allowed to change the world, but durable changes need an
authority path.

Three tiers:

```text
ephemeral
  created immediately in world state
  emitted as an entity lifecycle event
  expires or archives automatically

proposed
  recorded as a proposal event
  visible in the ledger and review queue
  can produce a patch

canonical
  merged into Simfile or Spawnfile source
  survives redeploys
  reviewed by a maintainer or steward policy
```

Agents can propose:

- entities and locations;
- new agents or roles;
- new variables;
- new generators or rules;
- new event types;
- changes to probes or marker policy;
- retirement of obsolete entities.

Agents should not directly commit canonical changes by default. The default mode
is proposal.

## Who Is In Charge?

Simfile is in charge of simulation governance. Spawnfile remains in charge of
runtime topology.

This means:

- Simfile decides whether a new entity can exist as world state.
- Spawnfile decides whether a new Moltnet room, agent, team, runtime, or memory
  bank becomes part of the deployable organization.
- A steward can bridge the two by approving a proposal that emits patches to
  both files.

For example:

1. An agent proposes `filing-incident-room`.
2. Simfile records `proposal.created`.
3. In proposal mode, Simfile may create an ephemeral world entity immediately.
4. If the proposal requires a durable Moltnet room, Simfile generates a patch to
   the Spawnfile network room list.
5. A maintainer or steward approves the patch.
6. Git records the canonical change.

## Git Traceability

Git is the durable audit layer for source-of-truth evolution.

Simfile should support:

- one real git branch per durable proposal;
- generated patches that touch Simfile, Spawnfile, or docs as needed;
- conventional commit messages;
- optional PR creation;
- provenance links from ledger proposal ids to branch/commit/PR ids;
- status output that shows unmerged proposals and deployed version drift.

Diff files rot; branches do not. Proposal branches are the default durable
review unit.

Suggested event chain:

```text
proposal.created
proposal.branch_created
proposal.patch_generated
proposal.review_requested
proposal.approved
proposal.merged
world.schema_updated
deployment.reconciled
```

This makes the world self-modifiable without becoming self-erasing. Agents can
ask for new structure, but durable reality changes through reviewed source.

## State And Ledger

Simfile runtime state should be rebuildable from:

- current Simfile source;
- linked Spawnfile resolved graph artifact;
- seed;
- event ledger;
- approved proposal patches.

Events should include:

- `event_id`;
- `kind`;
- `sim_time`;
- `provenance` (`mechanical` | `agentic` | `external`);
- `actor`;
- `target`;
- `scope`;
- `payload`.

Per-run constants — `run_id`, `seed`, `schema_version` — live in the run
manifest, not in every event line; `run_id` already prefixes `event_id`.
`sim_time` is deterministic simulation time derived from the clock tick,
never wall-clock time (the name says so, on purpose). If wall time is useful
for operations, it belongs in an optional non-identity field such as
`observed_at`, stripped from the canonical export.

Ledger `scope` values use the Mneme scope grammar: `global`, `agent:eleanor`,
`team:office`, `room:office-floor:case-warroom`, `pair:eleanor:sam`. A probe
joins ledger events against memory scopes without translation. Compiler status
subjects are provider-prefixed (`room:moltnet:<network>:<room>`); that seam
carries the one translation until the grammars unify. Attestation is honest:
the `room:` and `team:` forms appear in runtime code today; the `pair:<a>:<b>`
form is proposed, not attested — the one pair value in the repo is
dash-separated (`direct:pair:sam-eleanor`) — and belongs to the
grammar-unification open question.

The ledger is also the observability contract. A third-party viewer should be
able to render a useful live or historical view from the ledger plus read-only
state calls alone. Storage backends and the canonical export are specified in
Storage And Scale.

## Agent Tool Surface

Agents should interact with Simfile through tools, not by editing arbitrary
state files.

v2 tool families — agents are observers and speakers:

```text
world.status
world.observe
world.ledger
```

`world.act` mechanics have landed: one generic act, `{act_id, action:
"variable:set", variable, value}`, on a declared `fed_by` variable —
validated (dedup, run-open, declared-variable, authorized-actor,
finite-and-in-range, reject-never-clamp) and ledgered as a canonical
`world.act` event with `provenance: "agentic"`. What has not landed is the
live tool binding: today the only writer is a deterministic driver
(`RuntimeOptions.worldActs` / `simfile run --acts`), not an agent calling
`world_act` mid-turn. Any act grammar beyond `variable:set` (movement,
richer effects) is still deferred, same as the tool families below.

Deferred tool families — they land with v3 governance:

```text
world.propose
world.proposals
```

Until the live `world_act` binding lands, agents change the world the way
people do: by speaking in rooms and letting other agents and the world's
rules react — plus, since B58, a driver-mediated `world.act` for tasks that
need a mechanically scored variable write.

Provider-safe aliases replace dots with underscores (`world_status`, and so
on).

v2 delivery is mounted files plus CLI, with Daimon-native tools as snapshot
readers. HTTP and MCP delivery can be added later when a concrete runtime
integration requires them.

Ambient delivery — how an agent checks where the moon is:

- Daimon/Pi: `world_observe` is a native tool registered like the memory
  tools, implemented as a reader of the mounted snapshot — no IPC.
- Any CLI engine: the world runtime maintains a mounted read-only `world/`
  resource in each agent workspace with an always-current snapshot
  (`world/observe.yaml`), rewritten atomically each tick — the office-clock
  pattern generalized. Any engine that can read a file can perceive the world.
- MCP-native runtimes (OpenClaw/PicoClaw): a thin `world` MCP server exposing
  the same tools, as a later adapter over the same state.

The `world/` mount is an ordinary Spawnfile volume resource — the office-world
precedent, already real in the fixtures — with a host-backed backing directory
that the Simfile runtime writes and per-agent subpaths for scope filtering.
Spawnfile compiles the mounts; Simfile only ever writes files.

Visibility follows scope: `global` variables are observable by everyone,
`room:` variables by that room's members, `agent:` variables by that agent
alone. The observe snapshot is therefore a per-agent filtered view, written by
the runtime — the runtime-written sibling of the compile-written team-context
files. Agents see raw values plus an optional authored `description:` per
variable; interpretation is theirs. Reads remain unrecorded, per the ambient
channel rule.

## Documentation Plan

Docs should mirror Spawnfile's clarity:

- `README.md`: quickstart, boundary with Spawnfile, minimal example.
- `docs/concepts/kernel.md`: the seven primitives.
- `docs/concepts/channels.md`: world-to-agent channels and the perception rule.
- `docs/concepts/governance.md`: ephemeral/proposed/canonical changes.
- `docs/reference/schema.md`: full YAML reference — one canonical form.
- `docs/reference/cli.md`: commands and exit codes.
- `docs/reference/storage.md`: ledger backends, telemetry, run manifests.
- `docs/guides/office-sim.md`: autonomous office example.
- `docs/guides/brand-market-sim.md`: non-social market/brand fixture.
- `docs/guides/control-sim.md`: controller/pawn two-org world.
- `docs/guides/spawnfile-integration.md`: how to run with a Spawnfile org.
- `docs/guides/git-traceability.md`: proposal branches and PR workflow.

The genre guides are not decoration. They enforce the two-fixtures rule and
keep the schema honest; the control guide exercises information-road authoring
with zero schema additions.

## Testing Strategy

Tests should be behavior-first. Items are tagged with their CLI layer where it
matters; v3-tagged items are deferred along with governance:

- schema accepts minimal and rich Simfiles;
- lexical shorthands (`range: 0..1`, durations) expand in the lexer; the
  schema sees only canonical records;
- domain-noun lint rejects schema keys or enum values that encode fixture
  concepts;
- validation rejects duplicate ids and unreachable references;
- planner resolves Spawnfile ids from a resolved graph artifact without parsing
  Spawnfile YAML;
- deterministic run test (v2): same seed produces a byte-identical canonical
  ledger export, on every storage backend, per the Determinism Contract;
- telemetry snapshots re-derive exactly from source + seed + the replayed
  agentic/external event stream between snapshots;
- world runtime emits deterministic mechanical events tagged
  `provenance: mechanical`;
- rules enforce threshold conditions through data records;
- generators gated by `when:` hold-discipline fire only while the block is
  true (v2);
- a bare list under `when:` is a validation error pointing at `all:` (v0);
- `fire: once` rules are spent after first firing; `rule.fired` events carry
  the rule id as actor (v2);
- rule `variable:*` actions count as writers for the one-signal-writer check
  and land at the next tick boundary (v2);
- `set_eq:` signal generators are pure functions of clock and previous-tick
  state, and reject a second signal writer on the same variable (v2);
- the `eq` parser accepts grammar v1 only — unknown functions or syntax are
  validation errors; totality rules produce `doctor` warnings where reachable
  (v0);
- announcement actions fire once per threshold crossing, not per tick (v2);
- composed `when:` blocks fire on the false→true transition of the whole
  composite (v2);
- `for:` requires the condition to hold continuously; one false tick resets
  the hold timer (v2);
- a band atom (`above` and `below` together) is true only inside the band
  (v2);
- `moltnet:dm` is a validation error when the network has DMs disabled (v1);
- `when:` + `do:` is the only reactive form; former sugar keys (`once_at`,
  `say_in`, `when_above`, ...) are validation errors pointing at the
  canonical form (v0);
- an unknown `action:` type is a validation error (v0);
- `{variable}` placeholders in `content:` substitute current values at fixed
  precision; unknown ids are validation errors (v2);
- the observe snapshot is per-agent scope-filtered and atomically refreshed;
  an agent never sees a variable outside its scopes (v2);
- measured variables re-derive exactly on replay from the pinned agentic
  stream (v2);
- derived variables recompute in topological order; `doctor` rejects cycles
  in the derive graph (v1);
- `delta_eq` reads previous-tick values, so mutual feedback between variables
  is stable and replayable (v2);
- fed variables reject writes from any principal other than their declared
  instrument (v2);
- `doctor` warns when a rule's `moltnet:message` targets a room that feeds a
  measured variable in the rule's own condition (v1);
- variable motion is telemetry, never ledger events; post-run
  probe evaluation re-derives the mechanical series and matches streaming
  verdicts exactly (v2);
- local observation recommendation metadata is bounded and may supersede stale
  metadata; it never queues a delivery;
- the event fuse aborts a runaway tick loudly;
- marker tracer passes containment mode and propagation mode tests by content
  scan, ignoring annotations;
- marker `text:` defaults to the marker id; matching is case-insensitive
  exact over all declared aliases (v0);
- every containment marker auto-generates planted (allowed ≥ 1) and contained
  (unauthorized = 0) probes; an unplanted marker fails the run (v0);
- probes evaluate identically post-run and in `--follow` streaming mode (v2);
- probes measure ledger-visible behavior;
- run manifest reconstructs a complete run record with on-demand exports (v2);
- proposals produce real git branches and patches without directly mutating
  canonical source (v3);
- proposal approval links ledger ids to branch/commit metadata (v3);
- agent tool calls can create ephemeral state and proposed canonical state
  (v3);
- reports can reconstruct what happened from the ledger;
- harness-migration parity: ported probes reproduce the current autonomous
  office sim report numbers on the same inputs.

E2E fixtures should include:

- a tiny office world;
- a non-social brand/market world;
- a controller/pawn two-org world authored purely as information roads;
- an agent proposing a temporary entity (v3);
- an agent proposing a durable room patch (v3);
- an agent proposing a new support role (v3);
- a maintainer or steward approving one proposal and rejecting another (v3);
- a viewer/report generated only from the ledger.

## Scope: What Simfile Is Not

Simfile is a laboratory apparatus for small societies of language agents — a
deterministic instrument wall around a nondeterministic culture. Its
comparables are test harnesses and observability stacks, not NetLogo or Mesa.
The niche: reproducible, auditable experiments on information flow,
containment, symbol and norm propagation, and organizational dynamics in
societies of tens of LLM agents, where the world supplies pressure, rhythm,
stimulus, and measurement — not physics, resources, or space.

Boundaries, named so nobody discovers them by surprise:

- No metric space. Grids, coordinates, continuous movement, and contact
  physics are out of scope. Topological space — places, adjacency, travel
  time, presence — is different: it is access control over time, native to a
  society of speaking agents, and is designed as the deferred Space Module
  below.
- No populations. World state is individually authored scalars; there is no
  entity instantiation, no templating, and no aggregation over collections in
  `eq` (no loops, by rule 4). If a fixture ever demands population coupling,
  the lift is new *measure kinds* (sums/means over a scope's variables) —
  never loops in the grammar.
- No numeric conservation. Variables are independent clamped scalars;
  clamping mints and destroys value, so money-as-numbers needs a steered
  instrument (an external "bank" owning the invariants). Object conservation
  is different and is designed: discrete entities with single-location
  custody conserve by construction — see the Objects sketch in the Space
  Module section.
- No ensembles over live-agent behavior in the always-on mode. Replay is audit,
  not re-experiment: agentic events are pinned inputs, and wall-time
  concurrency reorders turns regardless of model settings. Controlled
  local scripted ensembles are available only in the deferred diagnostic
  lockstep mode with pinned engines and seeded sampling. They are not
  live-agent evidence. API-backed asynchronous societies stay audit-only.
- Sim time is chained to wall time through LLM inference. Compression trades
  directly against agent agency: a month-in-a-day world is one its
  inhabitants act in only a few times per sim-day. This is stack physics, not
  a bug.

## The Space Module (Designed, Deferred)

Space, for speaking agents, is who you can currently hear and how long until
you can hear someone else. The world model is borrowed whole from the oldest
corpus in gaming — the MUD / text-adventure tradition (Zork, LambdaMOO):
rooms and exits with travel, `look` (= `world.observe`), inventory (= `has:`),
and whisper/say/shout verbatim. Presence-gated delivery is MMO interest
management; a rule on `event: presence.changed` targeting a place is a
trigger volume — OnTriggerEnter, free by composition.

The research made the topological-vs-metric choice a settled result, not a
preference. Dourish/Harrison (CSCW): a MUD room has topology but no
intra-room position — "space is the opportunity; place is the understood
reality," and the spatial metaphor is worth far less for controlling
interaction than designers assume. EVE Online partitions its single shard at
solar-system (room) granularity, not metric cells. The strongest opposing
data point is honest: Benford's aura/nimbus model (the ancestor of MMO
interest management) is graduated and *presupposes a metric* — continuous
earshot falloff needs distance. We deliberately trade that graduation for
determinism and legibility: whisper/say/shout are three discrete tiers, not a
falloff curve, exactly as MUDs shipped them. The one adjacent caution
(Jupiter, 1995): mixing continuous media into a room model "denies the
metaphor" — so keep every channel discrete. The module adds topological
space — never metric space — and pays the full extension toll: it ships only with two fixtures
from different genres (an office-with-commute; a pilgrimage or trading-floor
world), and it is the intended awakening of the dormant entity-lifecycle
primitive, with places as its first (static) entities.

Sketch:

```yaml
places:
  office:
    room: office-floor:office-hall
    exits:
      street: 5m
  home_eleanor:
    room: office-floor:eleanor-home
    exits:
      street: 8m
  street:
    exits:
      office: 5m
      home_eleanor: 8m
```

Mechanics:

- Presence is world state, managed by the runtime: each agent is at a place
  or in transit on an edge. `presence.changed`, `transit.started`, and
  `transit.arrived` are ledger events — which is also everything a renderer
  needs: place graph + presence timeline + transcripts.
- Movement is a richer `world.act` grammar member, not the first: B58 landed
  the generic mechanics (one act, `variable:set` on a declared `fed_by`
  variable) ahead of presence. Movement adds its own preconditions (exit
  exists, agent at origin), a duration (the edge weight — the cab ride is
  presence spent in transit), and an effect at arrival, over the same
  accepted-or-mechanically-rejected, ledgered-as-agentic, replayed-as-input
  shape. Acts travel as speech to the world participant — structured messages
  parsed against a closed act grammar. No new transport, no MCP, no policy
  server.
- Situational awareness rides the observe snapshot: `at:`, `here:` (who else
  is present), `exits:` with travel times. Visibility already follows scope,
  so room-scoped variables naturally become local perception of where the
  agent is.
- Enforcement is a ladder, like memory isolation was. Soft (ships with the
  module): agents are woken only by their current place's room, and a
  presence-violation probe catches any message sent to a room the sender was
  not at — pure ledger arithmetic. Hard (a Moltnet feature, optional):
  `presence_policy: managed` rooms whose member/write set is driven by an
  authorized policy principal — the world credential holding room-admin
  rights on place-rooms. The module is shippable on the soft rung alone.
- Direct messages gain a spatial policy: co-presence, or a declared
  possession on both ends (`has: phone`). Possessions are a small declared
  set per agent — the first legitimately discrete state, scoped inside this
  module rather than leaking sets into the kernel.

Before this module, the information topology is already real, and
containment tests already mean something: room membership and write policy
define who can hear whom — the reviewer-tempting "flat rooms + membership +
chat rooms reachable by all members" minimal model is simply the v0.1 stack.
What this module adds is motion and time-varying access, never the topology
itself.

Presence over selflets — the execution truth this module gates: agents run
as sessions per room (the selflet model; OpenClaw's per-room sessions today,
the environment-context design's direction for all runtimes), so there is no
single runtime locus that "moves". Presence is a wake mask over the agent's
selflet set: the body invariant is at most one active place-bound selflet at
a time — the one for where the body is; other place-sessions are dormant
(soft rung: no wakes; hard rung: membership revoked). Chat-only rooms are
ungated — reachable from anywhere, modulo possessions — which is precisely
the room/place distinction. Movement is a mask transition, and continuity is
memory-shaped: the destination selflet wakes with the arrival perception and
Mneme recall, never with the origin's transcript. You arrive with memories,
not transcripts. Transit means no active place-selflet at all.

Micro-position (sketch, same gate): the prior art's one correction to
room-only granularity. Fifty years of shipped systems (Inform's supporters
and enterables, Fate zones, MUD furniture) converge on "topology first,
sparse micro-position second": rooms stay the only free-movement graph, and
each agent gets **at most one optional micro-location, bound to an
affordance** — `on` a supporter, `in` an enterable, `at` a named anchor,
`near` a door. Never coordinates; discrete state transitions, fully
deterministic. This is the smallest addition that buys tavern booths, beds,
counters, lookout posts, and the burglar in the wardrobe — and it prevents
the known failure of refusing it: room explosion, where every booth and
closet becomes a fake room. An agent `in` an enterable is concealed from the
room's `here:` (perception separate from custody, as Inform teaches) — hiding
is a position, not a flag.

Audibility (sketch, same gate): distance-based hearing without coordinates.
Agents never experience floats — they experience heard / barely heard /
didn't — so acoustics decomposes into three discrete mechanisms:

- Granularity is sub-places: a plaza too big for one acoustic space is
  several nested places, never a coordinate field. Authors tune quantization
  by adding places.
- Attenuation is edges: the place graph gains audibility edges with a closed
  vocabulary — `hears: {street: muffled}`. A `muffled` delivery is a
  content-free perception event ("raised voices carry from the hall") —
  mechanically templated, backed by the real message event, content
  withheld: the viewer's murmur rule applied to agent perception. Overhearing
  becomes a reason to spend travel time.
- Potency is three tiers on channels that already exist: whisper = a
  co-presence DM (private by physics); say = a room message; shout = an act
  to @world, re-broadcast with full content in the room and muffled
  perceptions in every hearing-adjacent place. Two refinements from the
  shipped-systems record: (a) **whispers leave a visible cue** — bystanders
  in the room perceive "X whispers to Y", content-free (MUD/MOO practice:
  preserves suspicion, etiquette, and the eavesdropping opportunity without
  leaking content); (b) the honest counterargument to muffled-only adjacency
  is that shipped shouts (GemStone's YELL, Second Life's 100m shout) carry
  *content* to adjacent rooms, and stripping it risks agents routing around
  the mechanic — our answer is that the legitimate long-range primitive
  already exists (chat-only rooms are ungated from anywhere), so shouts can
  stay dramatic rather than functional. If a fixture shows agents defecting
  to messenger chains, that is the signal to carry shout content one hop.

The soft rung needs no Moltnet changes — the world posts muffled perceptions
as an ordinary participant. Native audibility-managed delivery joins
`presence_policy: managed` on Moltnet's later list. Coordinates and radii
stay refused: continuous position is geometry state with O(N²) checks buying
fake precision, and the viewer already renders apparent distance as
presentation. possessions
generalize into an object registry — discrete entities with identity and a
single location at all times (an agent's inventory, a place, or a container).
Conservation is by construction: transfer is one ledgered event moving one
field, atomic because the runtime is the single writer; contention resolves
by act order, not transaction machinery. The design law that keeps it
kernel-clean: custody is physics (where the object is — kernel-tracked);
ownership is a social claim (content: docs, norms, registries), never schema.
Possession regimes are then three orthogonal, composable layers — the same
enforcement ladder as memory and presence:

```text
physics    object:take requires co-presence — always on
policy     per-world act toggle: taking from another's inventory rejected
           (theft physically impossible)
moral      toggle off: taking-from-held is possible but ledgered as a
           distinct, visible transgression event — sensed by the corral,
           policed by org agents, priced in reputation, never prevented
```

A fixture ships a possession regime as a norm pack — act-policy config plus
docs plus sensors and probes — composed, never a kernel plugin. Fungible
money stays out (numeric conservation, above); small-scale currency can be
objects (coins) when a fixture wants it.

Title is a document layer, and this is the research's correction to
custody-without-title. The strongest published objection (Koster's ownership
law; UO and EVE both re-inventing title through insurance flags, stolen
flags, and reimbursement rules after omitting it) is that belonging becomes
emotionally and politically thin unless claims are durable and legible. The
resolution keeps the principle and answers the objection: **claims are
world-native documents** — deeds, charters, receipts, loan notes, wills,
police reports, guild ledgers — expressed as entities-with-props or org
docs. Kernel physics ignores them entirely, except where a place's access
profile references them. Custody answers "where is it, who can move it now";
the claim ledger answers "what was alleged to belong to whom" — so burglary
is physically coherent *and* socially adjudicable, because police, insurers,
and households have a durable source of truth to argue from.

Belonging & access (sketch, same gate) — the two layers, from the shipped
record (UO housing, FFXIV estates, Second Life parcels, LambdaMOO locks,
Inform's door-and-matching-key):

- Belonging is a **charter**: a document naming a steward (an agent or an
  org) plus delegates for a place. "My house" is a socially visible role
  bundle — admit, eject, delegate, store — anchored to the charter, not a
  kernel flag. Upkeep/decay, where a fixture wants it, is expressible today:
  a measured activity variable plus a rule.
- Access lives on **doors, containers, and places — never per-item ACLs**
  (the unanimous granularity of everything that shipped; per-object
  permission matrices recur nowhere). A place carries an optional access
  profile — `public | invite | group | banned` lists under the steward's
  control (the enriched hard rung of `presence_policy: managed`); exits and
  containers can be locked against a key or token held via `has:`; trespass
  and ejection are ledgered events the corral can sense.
- The enforcement rung is **chosen per place**, and mass-market history says
  both extremes fail: soft-norms-only makes households impossible (Second
  Life grew its parcel toolbox because home disputes cannot all be
  community-moderation problems), while hard-prevention-everywhere kills the
  emergence (Koster on Trammel: subscribers doubled and "a lot of magical
  stuff stopped happening"). Homes default to the policy rung; commons
  default to the moral rung; a fixture can author its own Felucca and
  Trammel as two districts with different regimes — the ladder is per-place
  configuration, which is exactly what UO ended up shipping as two worlds.

Minds stay clean: Daimon and OpenClaw do memory, reasoning, and agency; the
world does situation. No agent prompt ever contains cab dynamics — only
"you arrive at the office; it is 9:12."

## Local Scripted Lockstep Diagnostic (Designed, Deferred)

The always-on architecture makes controlled ensembles over live-agent behavior
impossible: wall-time concurrency reorders turns, prompts diverge, cascades
follow. The deterministic e2e harness already runs the other way — one-shot
scripted cycles in a fixed order — and a local-only lockstep diagnostic can
absorb that execution model for pinned engines:

- The diagnostic clock waits: a tick does not advance until its scripted turns
  complete, executed in deterministic order.
- Sampling is seeded: each turn's sampling seed is
  `hash(run_seed:agent_id:turn_index)`, passed to the engine (ollama's `seed`
  parameter), derived exactly like generator streams. One run seed controls
  every source of randomness in the system — world and minds.
- Engines must be pinned local models, and bit-stability is a per-engine
  certification, not an assumption (GPU float-reduction order can flip logit
  ties). API engines are excluded by nature.

Under those conditions, N seeds are N controlled samples of scripted or pinned
local engine behavior. If implemented, `--lockstep` is accepted only with
explicit local diagnostic mode (for example,
`simfile run ./Simfile --local --lockstep --ticks 200`). It is ineligible for
live-agent evidence and never changes the composed runtime rule that the world
clock cannot wait for agent cognition.

## Prior Art

The design was checked against the published record; the full survey with
citations is `simfile/RESEARCH.md`. The short version: every borrowed
precedent held. Coordinate-free room+containment worlds are the settled model
across 50 years of interactive fiction (Inform) and shipped MMOs (EVE's
solar-system partitioning); deterministic-world/recorded-input replay is
proven at scale in RTS lockstep (Age of Empires, Factorio); `when`/`expect`
is a monitorable bounded-MTL fragment; and the mechanical-world stance is the
deliberate inverse of Concordia's LLM game master. The record also supplied
the hard numbers behind the honest-niche ceiling (Generative Agents, Project
Sid) and the two warnings now folded into the design: float determinism in
the transcendentals, and agent self-report as an unreliable diffusion
instrument (which is why markers trace content through the ledger).

## Open Questions

- How small can the first marker tracer be while still replacing the current
  autonomous-office leak scanner?
- Should world tools be served by Simfile itself, or generated into a fixture's
  world resource?
- What does the read-only, scope-tagged Mneme export contract look like? The
  tracer needs it to scan memory for markers; it is the one missing interface
  between subsystems.
- Should the stack's scope grammar unify on the Mneme form
  (`room:<network>:<room>`) or the compiler's provider-prefixed form
  (`room:moltnet:<network>:<room>`)? Simfile adopts the Mneme form until the
  stack decides.

## Initial Decisions

- The world file is named `Simfile`, no extension, YAML content — matching
  `Spawnfile`. The CLI defaults to `./Simfile`.
- Sections are id-keyed maps. Reactive constructs have exactly one form
  (`when:` + `do:`); the only shorthands are lexical (`range`, durations),
  expanded in the lexer. Former sugar keys were deleted — two dialects cost
  more than the lines they saved.
- `simfile plan` consumes the existing Spawnfile compile report first. A
  machine-only plan file is introduced only if the report proves too unstable
  as a contract.
- Any future `simfile dev` wrapper reuses the `simfile run` composed lifecycle
  and prints the delegated public operations before running anything.
- Durable proposals create real git branches, not loose diff files.
- Math lives in the closed `eq` grammar (v1, frozen function list); rule
  conditions and effects remain data records. There is no general-purpose
  language and no rules engine.
- The `eq` syntax is a JavaScript-expression math subset parsed by an
  existing parser (jsep or an acorn whitelist) — maximally LLM-authorable —
  with evaluation semantics (whitelist, totality, fixed precision,
  previous-tick scoping) owned by Simfile's evaluator. mathjs was considered
  and rejected for dependency weight and unpinnable surface; CEL for lacking
  math.
- The `when:` condition syntax is borrowed the same way: leaves are Home
  Assistant `numeric_state` vocabulary verbatim (`variable`/`above`/`below`/
  `for` with sustained-hold semantics), composition is JSON Schema's
  `allOf`/`anyOf`/`not` snake-cased to `all`/`any`/`not`.
- The effect syntax is borrowed too: `do:` lists of namespaced
  `action:` records (the Home Assistant services / GitHub Actions shape),
  from a closed kernel registry extended only by spec bump. There is no
  sugar: `when:` + `do:` is the only reactive form. There is one reactive
  construct — rules, with `fire: per_crossing | once`; separate beats were
  dissolved into it. They share one anatomy — trigger (`when:` + firing discipline) → actions — differing only
  in discipline: per-crossing vs once. String-expression
  dialects (GitHub Actions `if:`, Ansible `when:`, PromQL) were rejected for
  conditions to preserve the logic-is-structure / math-is-eq split; MongoDB
  `$`-operators and Kubernetes selectors for foreign key style and
  set-membership semantics.
- The ledger store is pluggable (`jsonl` | `sqlite` | `postgres`); JSONL is the
  canonical interchange format, and determinism is asserted on the canonical
  export.
- Variable history is telemetry, stored as periodic snapshots; nothing is
  stored that can be recomputed from source + seed.
- World content always travels in-world (rooms and DMs); the operator channel
  is never used by world mechanics.
- The steward role belongs to the operator organization (or a human), not to
  the Simfile kernel; governance policy in Simfile stops at emitting
  reviewable artifacts.
- A normative `simfile/SPEC.md` — dry: valid keys, semantics, ordering, the
  determinism contract, valid and invalid examples — is extracted when the
  kernel schema becomes code, mirroring the spawnfile `specs/` pattern.
  DESIGN.md remains the essay: philosophy, ecosystem, modules, refusals.
- A Simfile is one file. There is no composition, include, or overlay
  mechanism — none is demanded by any fixture. If one ever is, the recorded
  bar: it must be typed and semantic like Spawnfile's membership, never
  generic file merging. Nested running worlds never share clocks regardless
  — membranes have no windows.
- There is no Analysisfile. Falsifiable checks are declared with the world as
  probes; interpretive analysis consumes the run record (canonical ledger +
  manifest) from outside — SQL, notebooks, or analyst agents in an operator
  organization. If it can fail, declare it in the Simfile; if it needs
  judgment, run it as an agent over the run record.
