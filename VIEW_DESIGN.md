# Simfile Viewer Design

The viewer is to the run record what the ruler is to length: a cognitive
tool. Rulers, Cartesian planes, and Feynman diagrams earn their keep by
converting a class of inference into a class of perception — they are
notations with rules, not illustrations. The Simfile viewer must pass the
same test. It is a laboratory instrument for seeing societies of language
agents: organizations, overlapping organizations, information moving between
them, pressures on actors, possession, and the interiors of minds. It is not
a screensaver that happens to render agents.

The viewer ships with Simfile as `simfile view`, following the Moltnet
console precedent: a web app compiled to static assets, served locally by
the CLI. It renders a run record (replay) or a running world (live). It is
strictly observer-tier machinery: it consumes only the public observability
contract and holds no privileged access to anything.

One sentence version of the whole design: **everything with a place renders
in one continuous live GlyphCSS map; every placeless scope opens as a
portal; every glyph traces to a record.**

## Design Rules

1. Instrument, not illustration. Every view must name the inference it makes
   perceptual (containment breach, information asymmetry, pressure-action
   causality, access topology, witnessed-vs-remembered divergence). A view
   that cannot name its inference is decoration and does not ship.

2. Observer tier only. The viewer consumes exactly the public contract: the
   Spawnfile compile report, the canonical ledger export / run record, the
   telemetry snapshots, the Mneme scope-tagged export, and the Moltnet
   read API with an ordinary credential. No privileged endpoint, no imports
   of Simfile or Spawnfile internals. The viewer is the resident proof of
   DESIGN.md's observability contract: if the viewer needs something the
   ledger does not carry, that is a ledger bug to fix, never an API to add.

3. Pixel accountability. Every visual element — a body, a glow, an edge, a
   trail — must be backed by a ledger event, a scope, a telemetry snapshot,
   or a compile-report edge, such that pointing at any pixel can answer
   "which records make you true?" No decorative state, no invented motion.

4. Presentation never enters the Simfile schema. The kernel's
   genre-neutrality extends to rendering: no schema key may carry a model,
   a color, a layout hint, or an embodiment flag. All aesthetics live in a
   viewer-owned skin manifest keyed by the stable ids the world already
   has. A world with no skin still renders, via deterministic auto-layout.

5. One recursive notation. The unit of structure is the membrane: a
   container with an interior (members and their traffic) and a boundary
   crossed only through declared interfaces. Agent, team, organization, and
   society are the same component at different depths. The crossing
   vocabulary is closed and versioned; a relationship that cannot be drawn
   from it should also be impossible in the stack.

6. The two-layer rule. Things with a place render in the continuous
   GlyphCSS map. Scopes without a place — minds, chat-only rooms, DMs, docs,
   memory banks, object histories — open as portals. The self/world
   boundary is the canonical placeless membrane: continuous rendering stops
   exactly at the skin of the agent.

7. Time is one axis everywhere. The ledger's total order makes replay free;
   the scrub bar is global chrome, and portals are time-linked — scrubbing
   rewinds an open head's memory strata and an open chat's scroll position
   together with the world. Looking is never an event, all the way up to
   the human at the screen: opening portals, moving the camera, and
   scrubbing replay have no world side effects. Pausing a live world is an
   operator act, ledgered as external.

8. UI modes are the operator tiers. Observer, in-world, operator, and
   source are the only four hands a human can have in the jar, and the
   active tier must be unmistakable in the frame at all times. There is no
   fifth mode, because there is no fifth tier.

9. Ships with Simfile, written to be extractable. Like `moltnet/web/`, the
   viewer lives in the package it observes but touches it only through
   public artifacts, so extraction to a standalone product later is a move,
   not a rewrite.

## Position In The Stack

The Moltnet console is the precedent: `moltnet/web/` is a React + Vite app
compiled to static assets and served same-origin by the Moltnet binary,
consuming only the public `/v1` read API. The Simfile viewer copies the
pattern with one Node-flavored difference: instead of committing `dist/`
for a Go embed, the web app builds in `prepublishOnly` and ships inside the
npm package; the CLI serves it with a thin static handler.

Boundary clarifications:

- DESIGN.md's "HTTP and MCP are later delivery forms, not v2 scope" governs
  the agent tool surface — world-to-agent channels stay files and CLI in
  v2. The viewer's localhost server is human-facing observer tooling, the
  same lane as `simfile ledger --follow`, and is not constrained by that
  clause.
- The single-writer rule constrains writers. The viewer reads ledger stores
  concurrently (SQLite WAL, JSONL tail, Postgres) and never opens any store
  for writing.
- In DESIGN.md's operator-organization tiers, `simfile view` in its default
  mode is the observer tier made into a room you can stand in.

## Command Surface

Implemented commands today:

```bash
simfile view --state .sim/                 # live: attach to a running world
simfile view runs/<run_id>/                # replay: render a run record
simfile view --port 4400 --no-open
```

Future viewer flags, not current CLI surface:

```bash
simfile view --state .sim/ --moltnet <url> # live, with room traffic via /v1
simfile view runs/<run_id>/ --skin ./skin.yaml
```

Serving model:

- Live mode is primary. The CLI serves the static app plus a small read-only
  JSON + SSE surface over the active state directory: ledger tail, current
  observe-relevant state, telemetry snapshots, probe verdict stream, and a
  same-origin proxy to the Moltnet `/v1` read API so the browser needs one
  origin and one credential configuration.
- Replay mode is the same UI pointed at a sealed run directory
  (`manifest.yaml`, `ledger.jsonl`, report, telemetry snapshots, collected
  exports). The app uses the same store shape; the only difference is that
  "now" is a fixed end tick and no live SSE streams are open.
- The viewer's HTTP surface is read-only with two exceptions, both gated by
  explicit tier elevation (see Interaction Model): operator control actions
  proxied to their existing endpoints, and in-world participation proxied
  through Moltnet `human_ingress`. The viewer adds no write path of its
  own; it borrows the two that already exist and are already ledgered.

Layering, matching the CLI layers in DESIGN.md:

- v0-adjacent: live mode over the current autonomous-office harness output
  while it is being produced. The first viewer should watch the simulation
  run, tail the ledger/transcript stream, and keep the screen on "now".
  Sealed replay is generated from the same emitted records afterward.
- v2: canonical live mode, fed by the Simfile world runtime's state
  directory and the Moltnet event stream.
- v3: object portals over entity lifecycle events; proposal review surface.
- Space Module: presence becomes ground truth (`presence.changed`,
  `transit.started`, `transit.arrived`) and replaces the presence
  heuristic; travel renders as bodies in transit on edges.

## Data Contract

The viewer consumes three feeds. Two exist today; the third — the read-only
scope-tagged Mneme export — is DESIGN.md's named missing interface, and the
viewer's milestone 2 (head portals, witnessed-vs-remembered) is the forcing
function that gets it designed. Nothing before milestone 2 depends on it.

Structure — the Spawnfile compile report (`spawnfile-report.json`):

- nodes (agents and teams), runtimes, capabilities;
- `active_environments.moltnet` room bindings per node;
- the container plan's networks and rooms with `members`, `visibility`,
  `write_policy`;
- team membership and subagent edges; representative chains
  (`representedTeamName`, `representativePath`);
- memory banks with declaring node, accessible nodes, store and index
  configuration;
- docs and mounted resources per agent — the feed list for the head view's
  sensorium.

Events — one of:

- a canonical Simfile ledger export (JSONL, sorted keys, `event_id` as
  `<run_id>:<seq>`, `sim_time` derived from tick): world speech, wake
  recommendations, marker sightings, rule firings, lifecycle,
  agentic/external writes, `clock.sync`;
- the ported harness ledger (the autonomous-office
  `room-messages.jsonl` with `agent`, `room`, `text`, `day`, `phase`,
  `tick`, `order`) via the conversion shim;
- live: the Moltnet SSE stream (`/v1/events/stream`) joined with the world
  runtime's ledger tail.

State — variables and memory:

- telemetry snapshots (`telemetry.snapshot_every`) for scrubbable variable
  series; between snapshots the viewer interpolates only by re-derivation
  rules, never by visual smoothing that invents values (rule 3);
- the read-only scope-tagged Mneme export for memory strata, dream events,
  and the witnessed-vs-remembered diff;
- Moltnet `/v1` for room rosters, threads, DMs, and message pagination in
  live mode.

Presence, before the Space Module: a viewer-side heuristic — an agent
stands in the room of its most recent message or wake, dimmed when stale.
The heuristic is labeled as such in the UI (rule 3: derived pixels must
admit being derived). When the Space Module lands, presence events replace
the heuristic and the data model changes nowhere else.

## The Coordinate System

The stack already made its Cartesian-plane move in the scope grammar.
`global`, `team:<team>`, `room:<network>:<room>`, `agent:<agent>`,
`pair:<a>:<b>` is a shared coordinate system into which ledger events,
memories, and variables all plot. Sim time is the second axis. Everything
the viewer shows is a projection of scope × time.

Consequences:

- Linked selection. Selecting an agent, room, marker, or time range in any
  projection highlights it in all projections. Selection is the mechanism
  that turns pictures into an instrument.
- A variable's `scope:` is its render attachment point: `room:` scopes draw
  on the room, `agent:` scopes on the body, `global` on the atmosphere.
- Deep links. A view is a value: `(run_id, tick, camera pose, portal
  stack, selection, active lenses, tier)` serializes into a URL. A
  researcher points at a moment — "the instant the rumor jumped
  containment" — and a colleague opens the identical view. Determinism
  plus pixel accountability makes every citation reproducible.

## The Membrane Model

Every altitude has the same anatomy: an interior (members and their
traffic) and a membrane crossed only through declared interfaces. An agent
is a membrane around subagents and memory; a team around agents; a society
around organizations; the operator relationship is a membrane whose legal
crossings are the four tiers. Because nothing crosses any boundary except
through declared interfaces, every membrane has a complete ledger of what
crossed it — which is what makes the recursion renderable, and what makes
emergence detectable rather than smeared.

The viewer's core component is therefore one recursive container: interior
+ crossings + level-of-detail rules, instantiated from subagent depth to
society depth.

The crossing vocabulary is closed. Six types, six visual syntaxes:

```text
shared room      peer overlap: two containers holding a common surface
                 render: shared wall / border crossing between territories
representative   delegation: an agent standing in a room for a team
                 render: ambassador body wearing its home container's color
external member  a guest inside a boundary it does not belong to
                 render: visitor badge; distinct silhouette treatment
doc authority    one container obeying another's text (information roads)
                 render: faint directed edge; strength is compliance, and
                 the edge must never imply enforcement that does not exist.
                 honesty note: this is the one crossing with no backing
                 record — authority lives in doc prose, compliance is an
                 analysis-layer judgment. Until a record exists it renders
                 only from viewer-side annotation, badged "asserted", and
                 is exempt from the compile-report edge test
operator tier    source / operator / observer / in-world crossings
                 render: interventions as visible external-provenance
                 events; observation renders nothing (reads are not events)
nesting          a whole simulation as an object inside an operator org's
                 world
                 render: contained world object; interior visible only by
                 entering it (open question: the snow-globe treatment)
```

Extending this vocabulary requires a design change to this document, like
the act registry requires a spec bump. If a fixture produces a relationship
the vocabulary cannot draw, first check whether the stack actually permits
the relationship; the notation and the architecture are supposed to fail
together.

Containment is a lattice, not a tree. One agent belongs to several
membranes at once (the office lead is simultaneously in `office`,
`office-leads`, a family, and a friend group). Zoom is therefore
frame-relative: navigation is "enter this membrane," and the same agent
renders differently by frame — lead in the office frame, parent in the
family frame, peer in the friends frame. The presence map is the
privileged, body-shaped frame the user comes home to.

## The Two Layers

### The map

One continuous live GlyphCSS scene renders everything above the self
boundary that has a place. The default is an isometric ASCII map, not a
photoreal 3D world:

- places as geometry (buildings, rooms, streets), laid out from the place
  graph — or, pre-Space-Module, from the skin manifest plus deterministic
  auto-layout over the room graph;
- agent bodies at their presence locations; transit as movement along
  edges once the Space Module lands;
- organizations as districts and campuses: the society altitude is not a
  separate screen but the same scene zoomed out, with data-driven LOD
  (below);
- variable attachments: room-scoped pressure as glow or gauge on the room,
  agent-scoped state on the body, global variables as atmosphere;
- clock phases as the day/night cycle: lighting and soundscape follow
  `morning / workday / evening / night`, making the world's rhythm
  perceptual for free.

The map is a world, not a diorama, and its camera grammar is borrowed
from the most-learned zoom model in existence: Google Maps. The default
projection is isometric orthographic — an instrument argument, not taste:
orthographic preserves comparable sizes across the frame, so a glow or a
headcount at the scene's edge reads identically to one at its center
(perspective flatters; isometric compares). It is also GlyphCSS-native:
voxel/solid/wireframe glyph rendering keeps the map legible while the
simulation is moving. Perspective/orbit can exist as an inspection mode,
but the product grammar is map-first.

Zoom is continuous over discrete semantic bands, Maps-style, with content
defined per band:

```text
street     bodies, speech indicators, room interiors
building   rooms, presence, local gauges
district   org membranes as territory overlays; aggregate glow, headcounts
society    labeled clusters; social weather rendered as literal weather
```

At altitude there are two aggregations with distinct visuals, as in Maps:
spatial clustering (places merge into neighborhoods and districts — the
pin-merge pattern) and membrane territories (organizations render as
boundary shading over whatever places their members occupy — the
postal-district pattern; this is how the lattice renders without pretending
orgs are spatial). The police precinct is both at once: a building and a
jurisdiction. Lenses map to Maps layers: pressure is the traffic layer, flow
is transit lines, fog-of-war is unmapped territory.

Geometry is presentation. The kernel's space stays topological; the viewer
assigns coordinates the way a graph layout engine does. Nothing geometric
ever flows back into the schema (rule 4), so the no-metric-space boundary
in DESIGN.md is untouched.

### Focus and portals

The primary interaction is Maps-style focus, not page navigation. The
GlyphCSS map stays mounted as the base layer; selecting a room, organization, or
agent flies the camera to that rendered instance and opens the relevant
portal stack beside it.

```text
select office district
  camera focuses the office membrane
  side portal opens org view: rooms, members, active probes, recent events

select Eleanor in that frame
  camera keeps Eleanor highlighted in the office frame
  head portal opens: self context, memories, rooms, current activity

select after-work-chat
  camera highlights the room anchor or chat-only marker
  chat portal opens: transcript, roster, markers, threads
```

The portal is parallel to the map, not a replacement for it. Closing the
portal returns attention to the same map focus; opening another portal
stacks breadcrumbs (`world → office → Eleanor → memory`) and links
selection across every open view. This is the Google Maps analogy carried
through: the map gives orientation, semantic zoom controls detail, and side
panels hold inspection detail that would make the map unreadable.

### Portals

Every placeless scope opens as a portal — a modal that is a first-class
space, not a settings panel:

- the head of an agent: the canonical portal. Crossing the self membrane
  leaves the map by definition, because a psyche has no coordinates;
- chat-only rooms: a room the skin marks informational renders as a chat
  portal (transcript, roster, threads), optionally anchored by a small
  world object (a phone buzzing on a desk when the chat is active);
- DMs and pair scopes;
- docs and mounted resources;
- memory banks and dream records;
- object histories (v3);
- probe and report surfaces (verdicts, marker coverage, run summary).

Portal recursion: a portal contains the same recursive renderer. Opening a
head shows a small contained map — the inner organization rendered with
the same container component: subagents in their rooms, the sensorium (the
agent's feeds: room memberships, DM pairs, the `world/` observe mount, MCP
servers, mounted docs — all enumerable from the compile report), and
memory as strata. The Jungian fixture is the
reference case: a mind that is an org of animus and shadow renders with
zero special cases, because in this stack a psyche is a small organization.

Portals stack with breadcrumbs (`world → luna → shadow → shadow's
memory`). The portal stack is the concrete UI mechanic for frame-relative
membrane entry; a discrete crossing should feel discrete, which is why the
design chooses portals over continuous camera mounting/dismounting at the
self boundary.

Portals are time-linked (rule 7). Scrubbing rewinds portal contents in
lockstep with the world: memory strata unwrite, chat scrolls track the
scrubbed instant, variable gauges replay. A portal showing "now" over a
world showing "then" is the instrument lying, and must be impossible by
construction — portal components receive time from the same global clock
as the scene.

Opening a portal never pauses a live world. The world flows, portals
stream. Pausing is an operator act.

## Lenses

Lenses are the projections that make specific inferences perceptual. Three
are membrane interiors; two are cross-cutting overlays; one is a
comparison. Each names its inference (rule 1).

Map (presence lens) — interior of a place-bearing membrane. Inference:
access. Who is where, who can currently hear whom, co-presence. Information
can only flow where ears are, so watching bodies move is watching the
possibility-space of information flow change shape. This is the ambient
view left running on a wall.

At the district and society bands, the map lens composed with the time
scrubber becomes the timelapse — the Google Earth Timelapse pattern, one
more tool people already know. Inference: demographic response. Presence
history aggregates into population clusters and territory overlays that
re-derive per scrubbed tick, so a story beat or an org's nudge renders as
visible migration: a neighborhood empties, a congregation swells. The chain
stays accountable end to end — click a moving cluster for the ledger events,
open a head for the reasons. No new data: presence events, territories, and
the global time cursor already carry all of it.

Flow lens — overlay. Inference: propagation and containment. Marker
sightings (`marker.seen`), wake cascades, and symbol spread render as a
cascade: scope on one axis, time on the other, each sighting a node, each
plausible transmission an edge; in the map, recent transmissions render
as fading trails between rooms. A containment breach is a colored mark in a
region where that color must never appear — preattentive, seen before
read.

Pressure lens — overlay. Inference: pressure-action causality. Variables as
aligned strip charts with phase bands as background stripes and rule
firings pinned as event dots at the exact crossing: a climb, a threshold, a
wake, one visual gesture. Attachable to the map (gauges, glows) and
expandable into a full analysis portal (the EKG wall).

Org lens — interior of an organization membrane. Inference: authority and
interface topology. Teams, leads, memberships, and — critical for
multi-organization worlds — rooms rendered as the shared surfaces they
are. Two organizations relate only through their information roads, so the
overlap renders with the interface made physical: shared rooms as border
crossings. The controller's power is exactly as strong as its roads, drawn.

Head lens — interior of a self membrane; the org lens recursed into one
node. Inferences: attention and asymmetry. Contents: the inner constellation
(subagents), the sensorium (feeds), and memory strata (durable team scope,
ephemeral room scopes, pair scopes, dreams) from the Mneme export.

The head lens owns the single most valuable comparison the stack can make
perceptual: witnessed vs. remembered. The ledger states what happened in
every room the agent could hear; the memory export states what it kept.
Rendered side by side on one time axis, the diff is attention, bias, and
forgetting made visible. Two heads side by side is information asymmetry:
what one agent knows that another does not, at any scrubbed instant.

Emergence readout — comparison at any membrane. Interior traffic on one
side, exterior description (measured and derived aggregate variables — the
social-weather pattern) on the other, one time axis, linked selection.
Emergence is whatever the exterior description captures that no interior
element carries: a norm nobody decided, a rhythm in silence. Because
measures re-derive deterministically from recorded streams, the observation
is reproducible — a laboratory result, not a vibe. The same readout
applies at every depth: subagents → a coherent voice; agents → a team
culture; organizations → a society's norms.

## Asset Strategy

The viewer needs illustration assets, but assets must never become world
semantics. The default viewer has to render a useful live map with zero
authored art: deterministic GlyphCSS geometry, generic bodies, generated
labels, basic pressure glows, and portal HTML are the fallback contract.
Art then arrives through skins.

Asset sources, in preferred order:

1. Project-owned skins. A simulation can ship `skin.yaml` plus local assets
   under `skins/<name>/assets/` for its own offices, homes, agents, props,
   and ambience.
2. CC0 starter packs. The reference viewer skins should prefer public-domain
   low-poly packs, so examples can ship, fork, and redistribute without
   license friction.
3. Generated asset packs. For generic worlds, use generated voxel/mesh
   sets with checked-in prompts, source metadata, and content hashes so the
   pack is reproducible enough to audit even if the generator is not.
4. Explicitly licensed packs. Public-domain voxel/low-poly/icon
   assets are acceptable only with license metadata in the skin manifest.
5. Procedural primitives. When no asset exists, the renderer creates seeded
   platforms, silhouettes, markers, and simple buildings from ids and
   graph structure.

The primary render assets are GlyphCSS-supported meshes: `.vox`, `.glb`,
`.gltf`, `.obj`, and simple procedural polygon primitives. MagicaVoxel
`.vox` is the reference authored format because it is small, easy to edit,
and reads well at semantic-map scale. Bitmap assets are allowed for
portraits, portal illustrations, and generated texture references; they are
not the map renderer's base unit. UI icons come from the web app's icon
library, not from world skins.

Every non-procedural asset should carry:

```yaml
assets:
  office-open.vox:
    source: generated | authored | cc0 | licensed
    license: CC0-1.0
    prompt: prompts/office-open.md
    sha256: "..."
```

The manifest is documentation and audit trail, not simulation input. If an
asset is missing or forbidden by license checks, the viewer falls back to
procedural geometry and keeps the live run visible.

The first reference skin should be a small city/office pack, not a giant
world. Poly Pizza's Scenes & Levels catalog is a good browsing surface for
this, with Kenney's CC0 City Kit as the preferred first seed because it
ships GLTF and simple low-poly building silhouettes. Start with 10-20
assets: office building, home, street segment, park/tree, meeting room
shell, desk/table, doorway, generic agent pawn, ambient screen/ticker, and
marker beacon. At society and district zoom levels, the renderer should
mostly use procedural districts, labels, territory shading, and activity
pings; individual meshes matter only from building zoom inward. Paid packs
are fine for private skins, but canonical fixtures should stay CC0.

## The Skin Manifest

The schema is genre-neutral by DESIGN.md rule 1, so it can never say
"render `filing_pressure` as storm clouds" — that is a domain noun wearing
visual clothing. Presentation therefore lives in a viewer-owned skin file,
keyed by the stable ids the world already has:

```yaml
# skin.yaml — owned by the viewer, never read by simfile itself
skin_version: "0.1"

world:
  palette: warm-office
  ambience: office-day        # phase-driven soundscape set

places:
  office-hall:    { model: office-open.vox, footprint: large }
  case-warroom:   { model: office-room.vox }
  eleanor-home:   { model: house-small.vox }

rooms:
  after-work-chat: { physical: false }          # portal-only chat room
  break-room:      { physical: true }

agents:
  eleanor: { model: avatar-f-1.vox, accent: "#c44" }
  market:  { embodiment: ambient, render: ticker-wall }
  oracle:  { embodiment: none }                 # portal-only presence

variables:
  filing_pressure: { render: room-glow, palette: heat }
  evening_pull:    { render: sky-dim }

markers:
  OFFICE_SECRET_HAR_14A: { color: "#e0245e" }   # the breach stain color
```

Rules:

- Defaults everywhere. With no skin file, the viewer auto-layouts rooms as
  generic platforms from the room graph (deterministic layout, seeded by
  ids so two viewers of one run agree), generic avatars, variables as
  bars. The skin only overrides.
- `physical:` decides map vs. portal — but only for rooms no place
  binds. Pre-Space-Module no room officially has a place, so the bit is
  pure presentation; after, a place-bound room is physical by world
  semantics (`places:` binds it, presence gates it) and the skin cannot
  contradict that — it styles only the genuinely chat-only rooms.
- Embodiment is derived, then skinned. Whether an agent has a body is a
  world-side fact (it has presence state) — never a schema enum, which
  would smuggle domain nouns (`god`, `spirit`) into the kernel. The skin
  only chooses how placeless participants render: `ambient` (skybox, a
  radio murmuring, a ticker wall) or `none` (portal-only).
- Asset pipeline: GlyphCSS is the reference renderer. Mesh assets may be
  `.vox`, `.glb`, `.gltf`, `.obj`, or procedural primitives; `.vox` remains
  the preferred hand-authored style because it is chunky, fast to author,
  forgiving, and instantly reads as a simulation map.
- The Dwarf Fortress lesson, adopted precisely: DF's virtue is the total
  separation of simulation from presentation (tilesets, Stonesense) and
  its legends mode — browsable history for every entity. The viewer copies
  the skin/tileset separation and legends-over-the-ledger, and rejects
  DF's world model: no tile grid, no coordinates in the kernel. Renderers
  invent geometry from topology; they never define it.

## Skin Packs And Creation Workflow

Skins are an extension surface. The first implementation can ship one
office/city skin, but the design must support many spatial metaphors over
the same run record:

- `office-floor`: rooms as a floorplan, desks, conference rooms, hallways;
- `factory`: rooms as production zones, levels, control rooms, loading bays;
- `city`: teams and rooms as buildings, streets, districts, campuses;
- `campus`: multiple buildings with paths and courtyards;
- `countries`: orgs as territories on a political/economic map;
- `abstract-rooms`: graph/map layout with glyph platforms and portals, no
  fictional place claim;
- `terminal-board`: mostly schematic, optimized for dense monitoring.

These are skins, not Simfile kinds. The intended CLI lets a run choose one at
view time once `--skin` lands:

```bash
simfile view --state .sim/ --skin ./skins/city
simfile view runs/<id>/ --skin @noopolis/skin-office-floor
```

A skin pack is a directory or package:

```text
skins/city/
├── skin.yaml
├── assets/
│   ├── office-building.glb
│   ├── home-small.vox
│   └── agent-pawn.vox
├── prompts/                  # for generated assets, optional
└── README.md                 # license/source notes and intended genre
```

Future skin authoring commands should be thin but real:

```bash
simfile skin init city --template city
simfile skin validate ./skins/city
simfile skin preview ./skins/city --fixture autonomous-office-sim
simfile skin pack ./skins/city
```

Validation checks that referenced stable ids exist in the selected compile
report, asset files exist, external asset licenses are declared, hashes
match, unsupported formats fail early, and the skin still has a complete
procedural fallback. Preview renders a small live mock or fixture snapshot
so authors can tune scale, camera defaults, labels, and level-of-detail
without running a whole simulation.

Skin templates are allowed to include layout algorithms and defaults, but
not simulation rules. A `city` skin can say "rooms become buildings and
teams become districts"; it cannot make a variable move, add a room, or
change who can hear whom. This keeps skins shareable: the same office sim
can be viewed as a floorplan, a small city, or an abstract monitoring
board without changing the ledger.

## Interaction Model

### Time chrome

Persistent scrub/play/speed controls; day and phase readout; tick counter.
Replay is free because the ledger is totally ordered and mechanical state
re-derives from source + seed + pinned streams. In live mode the chrome
shows the head of the stream and allows rewinding the view (not the world)
into the recorded past. All portals and lenses follow the global time
cursor (rule 7).

### Tiers as modes

```text
observer   default. Free camera, all scopes visible, zero write surface.
in-world   the human takes a body via Moltnet human_ingress: a presence,
           a camera bound to that presence, speech into rooms they are
           in. To the simulated, indistinguishable from any participant.
operator   pause / resume / step, manual wakes, seed control — proxied to
           existing operator endpoints, every action ledgered with
           provenance: external and rendered visibly in-world as an
           intervention (divine stage direction, not silent edit).
source     opens the editor / repo, not the game. The viewer only deep-
           links out to files; it never edits.
```

Mode is always visible in the frame — border treatment, cursor, and label.
Switching into operator or in-world mode is explicit and requires the
corresponding credential; the viewer never escalates silently. There is no
fifth mode.

### Fog of war (perspective mode)

Render the world as a chosen agent perceives it: rooms outside its
membership dimmed to silhouettes, portals it lacks scope for refusing to
open, its own head the only enterable one. Implemented as pure scope
filtering — the scope grammar is shared with Mneme, so the filter is one
predicate. Doubles as the debugging view for "what did she actually know at
tick 340," and as the honest rendering of private rooms and DMs when a
viewer session is deliberately scope-limited.

### Attention layer

Tens of agents produce activity everywhere; an instrument that only
answers questions the user already knew to ask is half an instrument.

- Event ticker: a filterable feed of ledger events, salience-ranked.
- Salience is data-driven and fixed by class, not learned: probe
  violations and marker breaches outrank rule firings, which outrank
  wakes, which outrank chatter.
- Minimap: a schematic projection of the membrane lattice (not the main map)
  with pings at salient events; clicking a ping flies the map focus
  or opens the portal.
- Camera bookmarks and "jump to activity."
- Alert rail for streaming probe verdicts in live mode (`--follow`
  semantics rendered).

### Level of detail

LOD is driven by data, not only distance. Far: districts and buildings show
aggregate state (message-rate glow, pressure levels, headcount). Mid:
bodies, movement, room activity indicators. Near: conversational
indicators — who is speaking, activity bursts. Full text never renders in
the map; text lives in portals, where it is real HTML. This division is
also what keeps the GlyphCSS scene within a glyph-grid and mesh budget at
society scale.

## Object Portals (v3, With Entity Lifecycle)

When the entity lifecycle primitive activates, every entity gets a portal:
identity, current holder or location, and its full history as a ledger
query by entity id — spawned, modified, transferred, retired, each with
provenance. Legends mode per thing. Possession renders on bodies and in
head portals (the Space Module's `has:` set); transfers render as visible
handoffs on the timeline.

The viewer deliberately does not push this schedule. Ownership, trade, and
inventory land when fixtures demand them under the two-fixtures rule; the
viewer renders what the ledger records and nothing sooner. The game view
must never become the reason the kernel grows a game system.

## Rendering Stack

- Map: GlyphCSS via `@glyphcss/react` (or the vanilla custom element where
  useful) — a live ASCII polygon/mesh scene rendered into `<pre>` frames,
  with orthographic map controls as the default interaction. The scene uses
  GlyphCSS hotspots for selectable rooms, agents, org membranes, and
  salient events.
- Portals: plain HTML/React — transcripts, memory strata, strip charts,
  cascades. Text is text.
- Both layers hang off one store: the ledger/event feed, the compile
  report graph, telemetry series, the selection set, and the global time
  cursor. Linked selection and time-linking are store subscriptions, not
  cross-layer message passing.
- GlyphCSS's Three-compatible subpaths are allowed for authoring mesh
  transforms with familiar names, but the runtime renderer is GlyphCSS, not
  Three.js. The invariant from GlyphCSS carries over: one render cycle
  writes each `<pre>` once; no cell-by-cell DOM patching.
- Charts in portals follow the pressure-lens spec: aligned time axes,
  phase bands, event pins. No decorative animation (rule 3 applies to
  motion too: things move on screen only when records say they moved).

## Package Layout

```text
simfile/
├── src/
│   └── cli/            # `simfile view` command: static server + read API
└── web/
    ├── AGENTS.md       # canonical local guide, per repository rules
    ├── CLAUDE.md       # compatibility symlink to AGENTS.md
    ├── index.html      # Vite entry
    ├── src/
    │   ├── store/      # ledger feed, report graph, time cursor, selection
    │   ├── map/        # GlyphCSS scene: layout, bodies, LOD, lenses
    │   ├── portals/    # head, chat, doc, memory, object, report portals
    │   ├── chrome/     # time bar, ticker, minimap, tier indicator
    │   └── skin/       # skin manifest loading, defaults, auto-layout
    ├── public/
    └── package.json
```

Rules, inherited and local:

- `web/` imports nothing from `simfile/src/` except published artifact
  type definitions if they are exposed as a public entry; the honest
  default is to duplicate the artifact types from their documented shapes,
  the way a third-party viewer would have to.
- The CLI handler stays thin: it serves files, tails stores read-only, and
  proxies Moltnet; all viewer logic lives in `web/`.
- Named exports, files under 400 lines, tests beside files, nested
  `AGENTS.md` with a `CLAUDE.md` compatibility symlink — repository rules apply unchanged.
- Build ships via `prepublishOnly`; `dist/` is not committed.

## Testing Strategy

The structural test is the three-fixture test: one implementation of the
recursive container renders all three of the following with zero
special-case code paths. If any needs a special case, the notation is
wrong, not the fixture:

- `jungian-pi-org` — an org inside a head (portal recursion, head lens);
- `autonomous-office-sim` — an org of agents with overlapping membranes
  (lattice containment, presence heuristic, chat-vs-physical rooms, DMs);
- a controller/pawn two-org world — societies and interfaces (crossing
  vocabulary, org lens, doc-authority edges).

Behavior tests:

- pixel accountability: a hit test on any rendered element returns the
  record ids that justify it; a build fails if an element class has no
  record binding;
- replay determinism: rendering a run twice from the same record produces
  identical scene state at every scrubbed tick (auto-layout is seeded);
- time-linking: an open portal and the map never display different
  ticks; scrubbing during open portals rewinds both;
- scope honesty: fog-of-war mode never renders content outside the chosen
  agent's scopes — property-tested against the scope filter, and a
  scope-limited session cannot open out-of-scope portals;
- crossing vocabulary: every edge rendered in the org lens maps to one of
  the six crossing types derived from the compile report; unknown edge
  kinds fail loudly;
- the presence heuristic labels itself (derived-state indicator) and
  yields to presence events when a ledger contains them;
- salience ordering is stable and class-based; a probe violation always
  outranks chatter in the ticker;
- deep links round-trip: serializing and reopening a view reproduces
  camera, time, portal stack, selection, and tier;
- skin fallback: every fixture renders with no skin file present;
- tier gating: observer sessions hold no write-capable handles at all — 
  enforced by construction (the handles are absent, not disabled);
- live/replay parity: the same run viewed live and then replayed from its
  export renders identically at matching ticks (the viewer-side sibling of
  the probes' streaming/post-run parity guarantee).

## Sequencing

1. Live viewer over the autonomous-office simulation as it runs: map with
   auto-layout, presence heuristic, "now" time chrome, chat portals, ticker,
   probe stream, and marker alerts. Proves the coordinate system and the
   two-layer rule under real-time pressure instead of after-the-fact reading.
2. Replay/export parity for the same run: sealing the live run and reopening
   `runs/<id>/` must reproduce the same scene state at matching ticks.
3. Head portals and the witnessed-vs-remembered diff, using the Mneme
   export; the jungian fixture becomes renderable and the portal recursion
   is proven.
4. Flow and pressure lenses; deep links; fog of war.
5. Canonical live mode with the v2 world runtime and Moltnet SSE; operator and
   in-world tiers.
6. Space Module support: real presence, transit rendering, place graphs.
7. v3: object portals, proposal review surface.

The highest-value early milestone is not the prettiest map; it is a
trustworthy live instrument over a real office run. The viewer must show the
society moving while the run is happening, then prove accountability by
replaying the same emitted records afterward.

## Open Questions

- The nested-simulation render: when an operator org's world contains
  another simulation, is the inner world a portal (consistent: the inner
  sim has no place in the outer world's fiction) or a visible contained
  object — the snow globe — that opens into a portal? Leaning portal with
  a world-object anchor, the chat-room pattern one level up.
- Minimap projection: what is the right schematic for an overlapping
  membrane lattice — force-directed, nested rounded rectangles
  (treemap-like), or per-frame radial? Needs prototyping against the
  office fixture's seven overlapping teams. Note: Maps-grammar semantic
  zoom with territory overlays may absorb most of the minimap's job; decide
  after the zoom bands are prototyped.
- Skin manifest versioning and sharing: do skins ship inside fixtures
  (next to the Simfile, still never read by simfile itself), in a
  viewer-side directory, or both with precedence?
- Does the deep-link URL scheme need to survive canonical-export
  regeneration (stable across re-exports of the same run), and what is the
  identity anchor — `run_id` + `event_id` seems sufficient?
- Live-mode credentials: the viewer proxies Moltnet with one member
  credential; should scope-limited viewing (fog of war as an access
  control, not just a lens) use per-session credentials instead of a
  client-side filter for untrusted viewers?
- The harness-ledger dialect: how long does the viewer carry the
  conversion-shim dialect alongside the canonical ledger before replay
  support for pre-canonical runs is dropped?
- Text-to-speech / audio ambience: phase soundscapes are cheap, but does
  rendered speech (murmur intensity by message rate) violate the
  no-decorative-state rule or satisfy it as a rendering of real message
  events? Proposed answer: murmur bound to message-rate records is
  accountable; word-like audio that implies content is not.

## Initial Decisions

- The viewer ships inside the simfile package as `simfile view`, following
  the Moltnet console precedent; static web app served by a thin CLI
  handler; built at publish time, `dist/` not committed.
- The viewer is observer-tier by default and consumes only public
  artifacts: compile report, canonical ledger export or run record,
  telemetry snapshots, Mneme scope-tagged export, Moltnet `/v1`. No
  privileged endpoints exist. Missing render capability is a contract bug
  in the ledger, not cause for a private API.
- Live mode ships first, attached to the autonomous-office run while it is
  producing records. Replay is the audit path over those same records, not
  the first-class development target.
- One recursive container component renders every membrane depth; the
  crossing vocabulary is closed at six types and versioned in this
  document.
- The two-layer rule is normative: placed things in one continuous live
  GlyphCSS map — isometric orthographic by default (measurement honesty),
  perspective/orbit as inspection modes, semantic zoom on the Google Maps
  grammar with spatial clustering and membrane-territory overlays;
  placeless scopes as time-linked portals; the self boundary always opens
  a portal; portals recurse the same renderer and stack with breadcrumbs.
- Whether a room is physical or informational is a skin decision. All
  presentation lives in the viewer-owned skin manifest with deterministic
  auto-layout defaults; the Simfile schema carries zero presentation keys.
- Embodiment is derived from world presence state, never declared as a
  schema flag; skins only style the bodiless.
- UI modes are exactly the four operator tiers, always visible, never
  silently escalated; the viewer adds no write path of its own.
- Opening portals, looking, and scrubbing are never events; pausing a live
  world is an operator act with external provenance.
- The map renders with GlyphCSS; portals are HTML. GlyphCSS-supported mesh
  assets (`.vox`, `.glb`, `.gltf`, `.obj`) and procedural primitives are
  the visual substrate, with `.vox` as the preferred hand-authored style.
- Every rendered element is accountable to records; motion included. The
  presence heuristic self-labels until the Space Module provides ground
  truth.
- Deep links serialize complete views for citation; reproducibility of a
  pointed-at view is a feature requirement, not a nicety.
