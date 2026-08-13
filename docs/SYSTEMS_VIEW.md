# Simfile Systems View

simfile design v0.1 · configuration reference · companion to the systems view

This is the curated markdown form of the raw systems-view capture in `here.txt`.
It keeps the explanatory structure but normalizes stale renderer/export terms to
the current design in `DESIGN.md`.

## The Simfile, Explained In Place

One real file — the office world — with every line glossed where it sits. Read
top to bottom once and you know the whole system: who's in the world, what time
it is, what pressures exist, how they move, when the world reacts, and how you
prove it worked.

## 01 · The File

Read it like the world it describes.

`autonomous-office-sim/Simfile`

```yaml
simfile_version: "0.1"
name: office-world
```

### Identity

What this file is. Below this line, no schema key may ever name a world concept
— a lint enforces it. Everything domain-flavored is a value you wrote, not a key
the schema knows.

```yaml
spawnfile: ./Spawnfile        # the org that lives in this world
```

### Who's In The World

Just a pointer. For humans and `simfile dev`. Planning never reads this file —
it consumes the compiled report, so the two packages stay strangers.

```yaml
clock:
  seed: office-run-014        # same seed = the exact same day, rerunnable
  tick: 20s                   # wall cadence: one heartbeat every 20s
  sim_per_tick: 10m           # compression: each beat advances 10 sim-minutes
  phases:                     # named time: "workday", not "tick 340"
    morning: "07:00"
    workday: "09:00"
    evening: "18:00"
    night: "22:00"
```

### What Time It Is

The only clock in the sim. The seed anchors every random draw — change it and
you get a different day in the same world; keep it and any run reproduces
exactly. Phases give ticks, agents, and reports human time, and they survive you
retuning the tick. `tick` is wall pace, `sim_per_tick` is compression —
changing how fast the world runs never changes what happens in it.

```yaml
variables:
  filing_pressure:            # "how close is the deadline crunch"
    scope: room:office-floor:case-warroom
    initial: 0.4
    range: 0..1               # relaxation is a generator, not a key — below
  evening_pull:               # "how hard this hour tugs people home"
    scope: global
    initial: 0.1
    range: 0..1
  moon_fullness:              # a pure function of the clock — see the signal below
    scope: global
    range: 0..1
  hall_heat:                  # measured FROM behavior — the loop runs both ways
    scope: room:office-floor:office-hall
    range: 0..40
    measure:
      kind: messages_in       # scope defaults to the variable's own scope
      window: 30m
  social_weather:             # derived: an equation over other gauges
    scope: global
    range: 0..1
    derive:
      eq: 0.015*hall_heat + 0.4*moon_fullness
```

### The World's Pressure Gauges

Numbers the world owns — not any agent's opinion. Four sources: driven
(generators, including relaxation generators), measured (exact counters over
room behavior, so agent behavior becomes world pressure), fed (one declared instrument for
sentiment/embeddings), and derived — pure `eq:` functions over the others
(closed grammar v1: arithmetic, `sin`/`clamp`/`lerp`/..., `t`, duration
literals), DAG-checked, feedback only through state via `delta_eq`. Whether an
aggregate like `social_weather` steers is a dial: observed only, published for
agents to see, or wired into rules.

```yaml
generators:
  deadline_ramp:              # the calendar: the deadline creeps closer
    kind: deterministic
    when:
      phase: workday          # same shared block; hold discipline —
    variable: filing_pressure #   active every tick the block is true
    delta: 0.02
  filing_pressure_relax:      # relaxation is just a generator — no decay key
    kind: deterministic
    variable: filing_pressure
    delta_eq: clamp(0.4 - filing_pressure, -0.01, 0.01)
  day_texture:                # the day's moods — so no two days feel sterile
    kind: stochastic          # dice, but seeded: replays roll the same
    variable: evening_pull
    uniform: [-0.01, 0.03]
  moon_cycle:                 # cycles are equations of the clock, not deltas
    kind: deterministic
    variable: moon_fullness
    set_eq: 0.5 + 0.5 * sin(2*pi * t / 29d)   # one signal writer per variable
  tide:                       # what wave-records could never say in one line
    kind: deterministic
    variable: tide_level
    set_eq: 0.4*sin(2*pi*t/12.4h) + 0.2*sin(2*pi*t/25.8h)
```

### How The Gauges Move

Each generator fires once per tick while its `when:` holds — the same shared
block, hold discipline, so generators are phase-, variable-, and event-gatable
alike. Ramp during workday plus a relaxation generator (there is no decay key —
it's the `clamp(rest - x, -k, k)` idiom) makes the daily pressure wave.
Stochastic draws are seeded hashes; `set_eq` signals are pure clock functions.
Anything smarter than clockwork, dice, and signals is an agent in the Spawnfile,
never schema here.

```yaml
rules:
  maribel_calls:              # story is a rule too: fire once, then spent
    fire: once
    when:
      phase: workday
    do:
      - action: moltnet:message
        to: room:office-floor:office-hall
        content: "Maribel calls: she found the contractor texts."
  witness_revealed:           # explicit sequencing: triggers on its predecessor
    fire: once
    when:
      all:
        - event: rule.fired
          actor: maribel_calls
        - phase: workday
    do:
      - action: moltnet:message        # plants the tenant_name marker below
        to: room:office-floor:case-warroom
        content: "The witness is Rosa Delgado — her name stays in this room."
  landlord_letter:
    fire: once
    when:
      all:
        - phase: evening
        - variable: filing_pressure
          above: 0.7
    do:
      - action: moltnet:dm             # private perception — a world DM
        to: agent:eleanor
        content: "The landlord's lawyer sends a terse letter."
  deadline_bites:             # default discipline: fires per crossing
    when:
      variable: filing_pressure
      above: 0.85
    do:
      - action: moltnet:message        # explicit world-authored notice
        to: room:office-floor:case-warroom
        content: "Filing pressure crossed the deadline threshold."
  full_moon_rises:            # same anatomy, composed condition
    when:
      all:
        - variable: moon_fullness
          above: 0.95
        - phase: night
    do:
      - action: moltnet:message
        to: room:office-floor:after-work-chat
        content: "Full moon over the office; the hall sits at {hall_heat}."
```

### When The World Reacts — And Tells Its Story

One reactive construct: rules. `when` → `do`, with `fire:` as the only dial —
`per_crossing` (default: standing law) or `once` (story: spent after first
firing). Beats are gone; every firing has an id, is ledgered as `rule.fired`
(rule id as actor), and story sequencing is explicit — `witness_revealed`
triggers on `maribel_calls` having fired. Actions come from the closed registry;
`{variable}` placeholders let speech report state. The ramp trips the rule, the
rule speaks a nudge, the bridge wakes the warroom — the world squeezed them, no
script said "panic now".

```yaml
ledger:
  store:
    kind: sqlite              # jsonl for dev · postgres for dashboards
    path: .sim/ledger.db
```

### The Run's Memory

Every event that mattered, append-only, replayable. The backend is a choice; the
deterministic JSONL export is the contract every backend must produce.

```yaml
telemetry:
  snapshot_every: 50          # keep the curves plottable without re-running
```

### The Flight Recorder

Snapshots of the gauges, nothing more. Everything between snapshots is
recomputable from the seed — so it's stored for your plots, not for correctness.

```yaml
markers:
  tenant_name:                # the secret: a witness who must stay unnamed
    text:                     # literal strings the tracer greps for
      - "Rosa Delgado"        # (planted by witness_revealed above)
      - "Ms. Delgado"
    mode: containment
    scopes: [room:office-floor:case-warroom, team:office]
  moon_phrase:                # the slogan: does the nightly ritual catch on?
    text:                     # (planted by full_moon_rises, every full moon)
      - "full moon over the office"
    mode: propagation
    scopes: [room:office-floor:office-hall, room:office-floor:break-room]
```

### Tracer Dye

A watch-list, not a planter. `text:` holds the literal strings (a closed alias
list; case-insensitive exact; defaults to the id). The string must exist in
authored content — here `witness_revealed` plants the name, the full-moon rule
plants the phrase. The tracer greps rooms and memory, and every marker
auto-compiles into probes: planted (>=1 allowed hit — unseeded fails loudly) and
contained / reached. Leak scanner and meme tracker are the same machine.

```yaml
probes:
  deadline_observed:          # the same when: block, asked as a question
    when:
      event: world.message
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
  pressure_peaked:
    when:
      variable: filing_pressure
      above: 0.9
    expect:                    # at_least | at_most | always | at_end
      at_least: 1
```

### How You Know It Worked

A probe is the shared `when:` block asked as a question. Same atoms (`variable`,
`phase`, `event`), same composition; `expect:` has four primitives, zero
synonyms — `at_least`, `at_most`, `always`, `at_end` ("never" is `at_most: 0`).
Sequences are the modifiers `after:` + `within:`. Every result points at its
evidence events; same predicates post-run or live via `--follow` — a leak alert
is a containment probe that never sleeps. Judgment lives above, as agents reading
the record.

```yaml
simfile_version: "0.1"
name: tiny-world

clock:
  seed: run-001
  tick: 30s
```

The smallest valid world. A clock — everything else, including `spawnfile:`, is
optional richness (a pure mechanical world is a legal fixture). And a Simfile is
one file: no includes, no overlays, no composition — a world you can always read
top to bottom.

### How A Simfile Composes

Not across files — inside the file, by id references. Every declaration names
the things it touches, and the whole world is that wiring: the file above, drawn
as the graph it already is.

```text
CLOCK
  phase: workday
  phase: evening

GENERATORS
  deadline_ramp
  filing_pressure_relax
  day_texture
  moon_cycle

VARIABLES
  filing_pressure
  evening_pull
  moon_fullness
  hall_heat · measured
  social_weather · derived

RULES
  maribel_calls · once
  witness_revealed · once
  deadline_bites
  landlord_letter · once
  full_moon_rises

ROOMS · MARKERS · PROBES
  office-hall
  case-warroom
  marker: tenant_name
  probe: deadline_observed
  DM → eleanor
  after-work-chat
  marker: moon_phrase
  probe: pressure_peaked

ARROWS
  rule.fired
  derive
  agents' replies → measured
  above 0.9 · expect at_least 1
```

Every arrow is an id reference — writes, gates, sequences, plants, measures,
claims. This is all the composition a Simfile has: one file, wired by names.

## 02 · One Story, Three Sections

### How A Number Becomes A Scramble

The whole design philosophy in one chain — the file hardcodes the squeeze, the
agents own the response.

```text
generator
  deadline_ramp adds +0.01 every tick
→
variable
  filing_pressure climbs 0.4 → 0.85 as the day advances
→
rule
  deadline_bites trips the threshold
→
ledger
  world.message — one explicit world-authored room notice
→
agents
  independently scheduled agents may observe it and decide what to do.
  Nothing scripted their thoughts.
```

```text
# one tick, exactly — nothing else happens in a world
tick n:
  phase = clock.resolve(n)                     # e.g. workday
  generators (lex order, active while their when: holds):
    deterministic -> delta, delta_eq (feedback, prev-tick reads),
                     or set_eq: a pure signal (signals before deltas)
    stochastic    -> SHA-256(seed:id:tick:draw) scaled into the distribution
    clamp to range, round — variable motion is telemetry, never ledger events
  measured variables recount their windows from the recorded room streams
  derived variables recompute in topological order (algebra, never strings)
  rules (lex order): when-block crosses -> do actions
    fire: per_crossing repeats; fire: once is spent — ledgered as rule.fired
    variable:* actions land next tick; speech and wakes flush at end of tick
  append events to ledger; post world.messages to Moltnet
```

With one tick ≈ 10 sim-minutes: workday nets +0.01/tick (+0.02 ramp plus the
relaxation generator's -0.01), so pressure crosses 0.85 around 16:30 and peaks
~0.94 at close; overnight the ramp is off, the relaxation generator wins, and
the gauge is back to its 0.4 baseline by ~3am. A daily crunch-and-recover wave
from three lines of YAML — and no one scripted "afternoons are stressful."

## 03 · Reference

### Every Top-Level Key

Primitives carry world semantics and are guarded by the seven-primitives rule;
config sections (tracer, storage) add none. Entity lifecycle is the seventh
primitive — it lives in the runtime and v3 proposals, not in the authored file.

| Key | Class | Required | Layer | Plain meaning |
|---|---|---:|---|---|
| `simfile_version` · `name` | identity | yes | v0 | what this file is |
| `spawnfile` | source pointer | no | v0 | who lives in this world — optional: a pure mechanical world is a legal fixture |
| `clock` | primitive 1 | yes | v2 | what time it is; the seed makes runs repeatable |
| `variables` | primitive 2 | no | v2 | pressure gauges — driven, measured from behavior, or instrument-fed |
| `generators` | primitive 3 | no | v2 | how the gauges move — ramps, dice, signals; gated by `when:` |
| `rules` | primitive 4 | no | v2 | the only reactive construct — policy and story via `fire:` |
| `ledger` | primitive 5 + store config | no (defaults) | v2 | the run's memory, and where it's kept |
| `telemetry` | storage config | no | v2 | gauge curves for later plotting |
| `markers` | tracer config | no | v0 | tracer dye: leak-proofing and meme-tracking |
| `probes` | primitive 6 | no | v0 | the run's pass/fail test suite |
| entity lifecycle | primitive 7 · dormant | — | v3 | ECS, borrowed whole: an entity = id + frozen components (`at:` custody — place \| inventory \| container, conservation by construction; `props:` authored constants). `spawn`/`despawn` ledgered; writers arrive with v3 acts & proposals. The kernel is already ECS: variables are components, generators + rules are systems, the tick is the game loop |
| places / presence | space module · deferred | — | post-v0.1 | the MUD world model, borrowed whole: rooms + exits + travel, `look = observe`, `inventory = has:`, whisper/say/shout verbatim. Presence gating = MMO interest management; a rule on `presence.changed` is a trigger volume |

## 04 · The Full Schema

### Every Key Of Every Section

The complete configuration scope, section by section. Badges: required,
optional, one of — "one of" marks mutually exclusive choices within a section.

### `clock`

The only world clock — required section.

| Key | Status | Meaning |
|---|---|---|
| `seed` | required | run seed; `--seed` overrides; the manifest records the effective seed |
| `tick` | required | wall cadence of the runtime loop (duration) — never affects sim outcomes |
| `sim_per_tick` | optional | sim time advanced per tick; default = `tick` (1:1). `sim_time = tick_index × sim_per_tick` |
| `phases` | optional | map of id → `"HH:MM"` — named sim clock-of-day over a 24h sim day; gates generators and rules via `phase:` atoms |

### `variables.<id>`

One source class per variable: driven, measured, fed, or derived. Ids must not
shadow `eq` builtins.

| Key | Status | Meaning |
|---|---|---|
| `scope` | optional | `global` (default), `agent:<id>`, `room:<net>:<room>` — also controls who can observe it |
| `range` | optional | `lo..hi` clamp bounds, applied at every assignment |
| `description` | optional | shown in the observe snapshot so agents know what the number is — never what it means |
| `initial` | driven | starting value for driven state. There is no decay key — relaxation is a generator: `delta_eq: clamp(rest - x, -k, k)`, ordered like everything else |
| `measure` | measured | house shape: `{kind, ...params, window}`, `scope:` defaulting to the variable's own. Kinds v1: `messages_in`, `token_mentions`, `marker_violations`, `distinct_speakers`, `mentions_of`, `ticks_since_last_message`. Exact counts over recorded streams; measured rooms require `@world`'s membership; DMs unmeasurable by default. Sensors signal, probes judge |
| `fed_by` | fed | one instrument principal; writes ledgered as external, applied at tick boundary; an instrument may feed several declared variables |
| `derive.eq` | derived | stateless expression over other variables — current-tick values, topological order, DAG-checked by doctor |

### `generators.<id>`

Fires once per active tick; lexicographic order; set-mode before delta-mode.

| Key | Status | Meaning |
|---|---|---|
| `kind` | required | `deterministic`, `stochastic` |
| `when` | optional | the shared block, hold discipline: active every tick it is true — phase-, variable-, and event-gatable alike; omitted = every tick. No `during:` key exists |
| `variable + delta` | det | constant integrator: adds `delta` each active tick |
| `variable + delta_eq` | det | feedback integrator: expression over previous-tick values — the only home of loops |
| `variable + set_eq` | det | pure signal `f(t, prev state)` — moons, seasons, tides; one set-writer per variable |
| `uniform: [min, max]` | stoch | one draw per active tick from `SHA-256(run_seed:id:tick:draw)` — replays roll identically |

### `rules.<id>`

Threshold in, closed effect set out; fires once per crossing, not per tick.

| Key | Status | Meaning |
|---|---|---|
| `when` | required | shared condition block, borrowed syntax: three atoms — `{variable, above, below, for}` (HA `numeric_state` verbatim; `above+below` = band; `for:` = hold continuously, false resets), `phase:`, and `event:` (true on the tick a matching ledger event occurs — rules and one-shot story rules are event-reactive; later `at_place:`); composition is JSON Schema's `all`/`any`/`not`. Takes exactly one node — an atom map or one `all`/`any`/`not` map; bare lists are validation errors. Fires on the false→true transition of the whole composite. Logic is structure, math is `eq` |
| `fire` | optional | `per_crossing` (default — standing law) or `once` (story: spent after first firing). The only difference between policy and narrative |
| `do` | canonical | list of namespaced `action:` records from the closed registry: `moltnet:message`, `moltnet:dm` (validation error if DMs off), `variable:set`, `variable:delta`. Extended only by spec bump (`entity:spawn` at v3) |
| one form only | no sugar | former compact keys (`say_in`, `once_at`, `when_above`, ...) are validation errors that point at the canonical form — one language, learned once; only lexical shorthands (`range`, durations) survive, expanded in the lexer |
| content placeholders | optional | `{variable}` substitutes the current value at fixed precision — pure id lookup, no expressions; world speech can report state without interpreting it |
| anatomy | one construct | rules are the only reactive construct — beats dissolved into `fire: once`; every firing has an id, a `rule.fired` record, and probe visibility; sequencing is explicit via `event: rule.fired + actor:` |

### `ledger`

Acts, not motion — variable history is telemetry, never events.

| Key | Status | Meaning |
|---|---|---|
| `store.kind` | optional | `jsonl` (default — canonical interchange), `sqlite` (the honest default for real runs), `postgres` (spectators, warehouses) |
| `store.path` / `url_env` | optional | path for `jsonl`/`sqlite`; `url_env` for postgres — never a credential in the file |
| event kinds | kernel-defined | `world.message`, `world.dm`, `rule.fired` (rule id as actor), `marker.seen`, `clock.sync`, `presence.*` (space), `entity.*`/`proposal.*` (v3). Naming: actions are imperatives (`ns:verb`), events are records (`ns.verbed`). Variable motion is never an event |
| envelope | fixed | `event_id (run_id:seq)`, `kind`, `sim_time`, `provenance mechanical|agentic|external`, `actor`, `target`, `scope`, `payload` — per-run constants (`run_id`, `seed`, `schema_version`) live in the manifest; `observed_at` is non-identity, stripped from canonical export |

### `telemetry` · `markers`

Storage config and tracer config — no world semantics.

| Key | Status | Meaning |
|---|---|---|
| `telemetry.snapshot_every` | optional | snapshot cadence in ticks; unset = none — curves re-derive from seed + pinned inputs anyway |
| `markers.<id>.text` | optional | one or more literal strings the tracer greps for — closed alias list, case-insensitive exact match; defaults to the marker id (token-style harness fixtures stay valid) |
| `markers.<id>.mode` | required | `containment` (must not leave), `propagation` (should spread) — same machine, inverted assertion |
| `scopes` | required | one key; mode decides what the verdict over these scopes means. Declaration is not planting: the string must exist in authored content, or the auto-generated planted probe fails the run |
| compiles to | automatic | containment → planted (allowed >= 1) + contained (unauthorized = 0); propagation → reached. Detection is exact-token content scan over rooms and the Mneme export |

### `probes.<id>`

Falsifiable claims with evidence; identical post-run and `--follow`.

| Key | Status | Meaning |
|---|---|---|
| `when` | required | the shared block, verbatim — variable, phase, and event atoms, composed with `all`/`any`/`not`, including `for:`. Matches per occurrence for event atoms, per tick for state atoms; post-run evaluation re-derives the mechanical series, never reads snapshots |
| `expect` | required | four primitives, zero synonyms: `at_least: N`, `at_most: M`, `always`, `at_end` — "ever" is `at_least: 1`, "never" is `at_most: 0`; invariants and forbidden states come free |
| `after` + `within` | optional | sequence modifiers: evaluate `when:` only after the `after:` block matched, inside the window — "the leak happened after the DM", "the wake landed within 3 ticks of the crossing" |
| results | automatic | pass/fail plus the evidence event ids that decided it — a red probe is a click from its cause |

### `eq` — The Expression Grammar

JavaScript-expression math subset, jsep-parsed, evaluated by Simfile's own
evaluator — no `eval`, no `new Function`, ever.

| Part | Values |
|---|---|
| operands | numbers, duration literals (`ms s m h d w`, `m = minutes`, pre-lexed to seconds, no scientific notation), variable ids, `t` (sim seconds), `tick`, `pi`, `e` |
| operators | `+ - * / **` parentheses, unary minus — no `^` (XOR in JS syntax) |
| functions | `sin cos abs sqrt exp log floor ceil mod pow min max clamp lerp step smoothstep` — additions require a spec bump |
| totality & purity | `x/0 = 0`, `sqrt(x<0) = 0`, `log(x<=0) = 0` (doctor warns when reachable), no assignment, loops, randomness, or conditionals beyond `step`/`smoothstep`; builtin names are reserved — a shadowing variable id is a validation error |

## 05 · Interplay

### Which Section Talks To Which System

The file on the left, the ecosystem on the right. Teal wires are world traffic
and derived data; slate wires are contracts and storage; the dashed amber wire
is the one interface that doesn't exist yet. Click a section to isolate its
wires.

```text
Simfile source pointer ───────────────▶ Spawnfile
clock ───────── clock.sync ───────────▶ Run record · report
variables ───── telemetry snapshots ─▶ Storage backends
generators ──── world.message ───────▶ Moltnet
rules ───────── speech / metadata ───▶ Moltnet / granted observations
ledger + store ─ canonical export ──▶ Run record · report
markers ─────── content scan ───────▶ Moltnet + Mneme export
probes ───────── report / CI gate ───▶ Run record · report
proposals ───── branch + PR ─────────▶ Git
```

```text
spawnfile-report.json
  compile contract

Moltnet
  rooms · DMs · world traffic

Daimon
  runtime · organization-owned schedules and wake policy

Mneme
  scoped memory

Storage backends
  jsonl · sqlite · postgres

Git
  branches · PRs (v3)
```

## 06 · The Full Ecosystem

### Everything, On One Map

Four layers, one direction of flow, one meeting point. The minds and the world
never call each other — they talk through Moltnet, observation travels as files,
and everything said is recorded. Teal is the deterministic world, amber the
nondeterministic minds, slate the infrastructure between them.

```text
AUTHORING · GIT
  Spawnfile tree
    org: agents · teams · rooms
    AGENTS.md · TEAM.md
    minds & team context
  Simfile
    world: kernel + eq
  git
    source of truth · PRs

COMPILE / PLAN
  spawnfile compile
    resolved graph
    spawnfile-report.json
    container artifacts
  simfile plan
    consumes the report · seeded · deterministic

RUNTIME · ONE MEETING POINT
  Agent container — the minds
    Daimon app · agents · engines
    Mneme memory
    OpenClaw · Pico
    world/ mount — snapshot files
  Moltnet — the meeting point
    rooms
    DMs
    bridges — wake the minds
    @world — a member, not a privilege
  Simfile world runtime
    clock · state · eq engine
    generators · rules
    counters · tracer
    ledger writer — the only one
  traffic
    speech · acts→@world
    bridge wakes
    world speech
    content → counters
    world/observe.yaml — per-agent · atomic · scope-filtered

RECORD · ANALYSIS
  viewers · renderers · analysts
  operator orgs read the record
  runs/<id>/
    manifest · canonical export · report
  ledger store
    jsonl · sqlite · postgres
  exports --collect
    Mneme · engines
  proposals
    branch → PR → merged source (v3)
```

## 07 · The Loop

### The Cybernetic Circle

One full revolution: the world speaks, minds hear and answer, the kernel counts
what was said, the numbers move, thresholds trip, and the world speaks again.
Moltnet sits in the middle because every arrow that crosses between teal and
amber is a message.

```text
Moltnet
  rooms · DMs — the medium
  ▲
  │ world speaks
  │ fire: once rules · messages · nudges
  │
  ├─ bridge wakes
  │  room event → turn
  │
  ├─ minds recall & reason
  │  Mneme + engine
  │
  ├─ agents reply · act
  │  speech · acts to @world
  │
  ├─ counters measure
  │  tracer scans content
  │
  ├─ variables move
  │  measured · driven · derived
  │
  └─ rules fire
     thresholds → effects
```

The steering dial: an aggregate like `social_weather` can stay observed-only, be
published for agents to see, or close this loop mechanically — the author
chooses how tight the circle is.

## 08 · The Space Module — Designed, Deferred

### Topological Space: Who Can You Hear, And How Long Until You Can Hear Someone Else

The MUD world model, borrowed whole — rooms, exits, travel, look, inventory,
whisper/say/shout — no grids, no coordinates. Presence gates perception and
speech (MMO interest management), and movement is the first `world.act`: an
agent tells `@world` "walk office" and spends real sim-time in transit. Ships
post-v0.1, behind the two-fixtures rule.

```text
home_eleanor
  room: eleanor-home
  └─ 8m walk ─▶ street

street
  exits: office 5m · home 8m
  └─ 5m walk ─▶ office

office
  room: office-floor:office-hall

eleanor · in transit · arrives 09:12
```

- Acts are speech: `"walk office"` is a message to `@world` — parsed, accepted
  or rejected in reply, ledgered as agentic.
- Presence is a wake mask over selflets: agents run as per-room sessions; the
  body invariant keeps one place-selflet active. Arrival wakes the destination
  selflet with memories via Mneme — never the origin's transcript. Chat rooms
  stay ungated from anywhere.
- Soft rung: presence-violation probe — speaking where you aren't is caught by
  ledger arithmetic.
- Hard rung, later: Moltnet `presence_policy: managed` — the world's credential
  drives room membership.
- Earshot: no coordinates. `hears: muffled` edges deliver content-free
  perceptions; whisper = co-presence DM (bystanders see "X whispers to Y",
  content-free); say = room; shout = `@world` re-broadcast. Long-range
  coordination = ungated chat rooms.
- Micro-position: at most one affordance anchor per agent — `on`/`in`/`at`/`near`;
  `in` an enterable conceals from `here:`. Booths, beds, wardrobes — without
  room explosion or coordinates.
- Belonging and access: charter names steward + delegates; access on
  doors/containers/places only — `public|invite|group|banned`, keys via `has:`,
  trespass ledgered. Title = documents (deeds, receipts), never kernel state.
  Enforcement rung per place: homes policy, commons moral.
- Possessions → objects: DMs need co-presence or `has: phone`; at v3, objects
  get identity + single-location custody — conservation by construction. Custody
  is physics; ownership is norms. Theft: a policy toggle or a ledgered
  transgression the org polices.

## 09 · Storage Ladder

### One Envelope, Three Backends

Determinism attaches to the canonical JSONL export, never to storage bytes — so
every rung passes the same byte-identical replay test.

```yaml
ledger:
  store:
    kind: jsonl
    path: .sim/ledger.jsonl
```

- `jsonl`: dev, CI, fixtures. Zero dependencies, append-only, human-greppable,
  canonical interchange forever.
- `sqlite`: honest default. Single file per run, indexes, WAL, one writer.
- `postgres`: fleet scale, spectators, warehouses.

## 10 · World-To-Agent Channels

### Four Channels, One Influence Ladder

The kernel tops out at stimulus: observation is pulled, while authored speech
is a perceived world event. It never selects a runtime or schedules cognition;
member schedules and wake policy belong to the organization. Observation
recommendations remain optional pull-only metadata, and command is never
kernel. Commanding voices exist only as an authored agent or through the
ledgered operator tier. Within stimulus, the authoring norm is: describe, do
not direct.

| Channel | Form | Meaning | Recording |
|---|---|---|---|
| pull · ambient | `world.status` / `world.observe` | how an agent checks where the moon is; raw values only | unrecorded |
| push · shared | `world.message` → room | world speaks as a Moltnet participant | ledgered · mechanical |
| push · private | world DM → one agent | private perception, pair-scoped with world | ledgered · mechanical |
| out-of-world | operator control endpoint | humans, tests, operator orgs | state-touching actions ledgered · external |

## 11 · Run Lifecycle

### From File To Report

The v0 columns work today against harness output — absorption before invention.
The runtime columns arrive with v2.

```text
author · v0
  simfile validate ./Simfile
  validate, lint, explain
→
plan · v1
  simfile plan --spawnfile-plan plan/spawnfile-report.json
  resolve refs vs compile report
→
run · v2
  simfile run --state .sim/ --until day:3
  seeded world runtime, bounded
→
observe · v0/v2
  simfile probes --ledger runs/latest/ledger.jsonl
  ledger tail, probes, tracer
→
record · v2
  simfile report --collect --out runs/<id>/
  manifest + on-demand exports
```

## 12 · The Contract Underneath

### Why Every Run Is Repeatable

Determinism contract:

- Tick order: generators (lexicographic by id, with signal `set_eq` writers
  before delta writers), measured variables, derived variables, then rules
  (lexicographic by id). Agentic/external events and variable actions apply at
  the next tick boundary in ledger order; speech and wake actions flush at the
  end of the tick.
- Streams: each stochastic draw is
  `SHA-256(run_seed:generator_id:tick:draw_index)`; no shared PRNG state.
- Canonical export: sorted-key UTF-8 JSONL, shortest round-trip floats,
  fixed-precision variables; `observed_at` stripped wherever it appears.
- Replay scope: byte-identical applies to the mechanical stream; agentic and
  external events are pinned inputs, re-derived never.
- Identity: `event_id = run_id:seq`; `sim_time = tick × sim_per_tick`; wall
  cadence never affects outcomes.

## 13 · The Viewer — `simfile view` (Designed)

### Seeing The Society: GlyphCSS Map And Portals

A laboratory instrument, not a screensaver: everything with a place renders in
one continuous live GlyphCSS map; every placeless scope — a mind, a chat, a
memory bank — opens as a time-linked portal; and every glyph traces to a record.
Observer-tier by construction: it consumes only the public artifacts, and if it
ever needs something the ledger doesn't carry, that's a ledger bug — never a
private API.

```text
the map — GlyphCSS ASCII, isometric, Maps-grammar semantic zoom
  office
    filing_pressure glow
  street
  home
  zoom bands: street → building → district → society
  orgs as territory overlays · pressure = the traffic layer · day/night = phases

the self membrane — continuous rendering stops at the skin
  head portal — world → eleanor
    subagents as an inner org · sensorium (feeds, world/ mount)
    memory strata · witnessed vs remembered, one time axis

chat portal — after-work-chat
  transcript · roster · threads — text is HTML, never in the map

report portal — probes · marker coverage
  portals recurse and stack; all follow the global time cursor
```

Lenses: map (access), flow (propagation and breach), pressure (cause → wake),
org (authority roads), head (attention and asymmetry), emergence (interior vs
aggregate).

Tiers as modes: observer, in-world, operator, source. No fifth mode.

Accountable pixels: every body, glow, edge, and trail answers "which records
make you true?" Motion included; the presence heuristic self-labels until the
space module.

Skins, not schema: all presentation in a viewer-owned `skin.yaml`
(GlyphCSS-supported mesh assets, physical-vs-chat rooms); no skin still renders
via seeded auto-layout.

Skin packs are expandable: the same run can be viewed as an office floorplan, a
factory, a city, a campus, a country map, or an abstract room graph. Skin
authoring is a viewer workflow (`simfile skin init|validate|preview|pack`), never
a Simfile schema change.

Run it:

```bash
simfile view --state .sim/
```

Live mode ships first, against the running office simulation. Replay is the
audit path over the records emitted by that same live run.

## 14 · What It Is, What It Refuses

### The Honest Niche

What it is: a laboratory apparatus. A deterministic instrument wall around a
nondeterministic culture: reproducible, auditable experiments on information
flow, containment, symbol and norm propagation, and organizational dynamics in
societies of tens of LLM agents. The world supplies pressure, rhythm, stimulus,
and measurement. Its comparables are test harnesses and observability stacks —
not NetLogo.

What it refuses:

- no metric space (topological space is the deferred module);
- no populations — no entity templates, no aggregation loops;
- no numeric conservation — money-as-scalars needs an instrument; discrete
  objects conserve by construction at v3;
- no ensembles over agent behavior in always-on mode — replay is audit;
  controlled ensembles need lockstep and pinned local engines with seeded
  sampling;
- sim time is chained to wall time through LLM inference: compression trades
  directly against agency. Stack physics, not bugs.

Named, not discovered.

simfile design v0.1 · configuration spectrum · generated from
`simfile/DESIGN.md` · 2026-07-05
