# Simfile Viewer Styleguide

Concrete visual and functional standard for the `simfile view` console. This is
the implementation layer under `VIEW_DESIGN.md` (philosophy, two-layer model,
membranes, tiers) and above the code in `web/src/viewer/`. It is also the
grading rubric for the B49 render acceptance gate: section 7 is a checklist of
objective assertions a Playwright run can evaluate against screenshots, the DOM,
and `viewer-trace.json`.

Shared foundation (canvas, neutral ramp, fonts, accent trio) follows the
Noopolis design system and is not restated here except where the viewer binds
it to data semantics. GlyphCSS (`@glyphcss/*@^0.1.0`, the frozen published
dependency) is the map substrate; the local GlyphCSS checkout is reference-only
and never a build input.

---

## 1. Resolved design questions

VIEW_DESIGN.md lists seven open questions. They are decided as follows. Changing
any of these requires editing this document, the same discipline as the closed
crossing vocabulary.

### 1.1 Nested-simulation render: anchor object plus portal

A contained simulation renders as a world object anchor in the outer map (a
seeded procedural "core" glyph cluster, class `nested-world`, sized like a
small building) and its interior opens only as a portal. There is no continuous
camera descent through the outer world into the inner one. This is the
chat-room pattern one level up: the phone on the desk anchors the chat, the
core on the campus anchors the inner world. The portal runs the same recursive
renderer with its own time cursor slaved to the inner run's ledger, mapped to
the outer clock through the containment record. Breadcrumbs show the descent:
`world > research-org > sim:office-v3`.

### 1.2 Minimap projection: seeded treemap with membrane outlines

The minimap is a squarified treemap of the room graph, seeded by stable scope
ids (deterministic: two viewers of one run produce the same minimap), with
organization membranes drawn as rounded outline overlays over the tiles their
members occupy. Overlap renders as outline crossings, not nested containment,
because containment is a lattice. Force-directed layout is rejected (unstable
across sessions, breaks deep links); per-frame radial is rejected (no stable
home view). Salience pings render as 6px dots at tile centers; clicking a ping
flies the main map focus. The minimap never renders bodies, text, or variables:
it is lattice plus pings only, 200x140 px minimum, in the chrome corner.

### 1.3 Skin manifest versioning and sharing: both locations, fixed precedence

Skins live in both places with explicit precedence, highest first:

1. `--skin <path|package>` CLI flag,
2. `<run_dir>/skins/<name>/skin.yaml` sealed with a run record,
3. fixture-adjacent `skin.yaml` next to the Simfile (never read by simfile
   itself),
4. built-in procedural default.

`skin_version` is required and gates loading: the viewer accepts only manifests
whose `major.minor` it supports (currently `0.1`); a mismatched version falls
back to the procedural default with a visible warning chip, never a partial
load. Unknown keys warn and are ignored. Shared skins are npm packages
(`@scope/skin-*`) whose root contains `skin.yaml`; `simfile skin validate`
is the compatibility contract, and a skin that fails validation renders as if
absent.

### 1.4 Deep links: stable across re-exports, anchored on run_id + event_id

Deep links must survive canonical-export regeneration. The identity anchor is
`run_id` plus `event_id` (`<run_id>:<seq>`), never a wall-clock time and never
a raw tick, because ticks are derivable from the event but events are the
stable citation unit. URL scheme, versioned:

```text
/view?v=1&run=<run_id>&at=<event_id>&cam=<x>,<y>,<zoom>&sel=<scope>
     &portals=<scope>/<scope>&lens=<id>,<id>&tier=observer
```

Camera pose quantizes to 2 decimal places so trivially different poses produce
identical URLs. Opening a v1 URL against a regenerated export of the same run
must reproduce the identical view (section 7 asserts this). Unknown future
params are ignored; a missing `at` means the run's final event in replay and
"now" in live mode.

### 1.5 Live-mode credentials: per-session server-side scoping

For untrusted viewers, scope limiting is an access control, not a lens:
the CLI mints per-session read credentials scoped to a set of scopes, and the
server filters the ledger tail, telemetry, and Moltnet proxy responses before
they leave the process. Client-side fog-of-war filtering is a lens for trusted
local sessions only (debugging "what did she know"), and the UI labels which of
the two is active. A scope-limited session cannot fetch out-of-scope records at
the HTTP layer, so no client bug can leak them. One Moltnet member credential
still backs the proxy; per-session scoping is applied by the viewer server on
top of it.

### 1.6 Harness-ledger dialect: shim until canonical plus two minors, then external

The conversion shim for the autonomous-office `room-messages.jsonl` dialect
ships inside the viewer until the canonical ledger export has been the default
for two minor versions of simfile. After that the shim moves to
`simfile ledger convert` (a one-shot converter producing a canonical export)
and the viewer reads only the canonical dialect. Pre-canonical runs stay
replayable forever through conversion; the viewer just stops carrying two read
paths. The shim always stamps converted events with
`provenance_note: "converted:harness-v0"` so pixel accountability can name the
translation.

### 1.7 Audio: rate-bound ambience yes, content-implying audio no

Phase soundscapes (skin `ambience:`) and murmur intensity bound to per-room
message-rate records are accountable renderings of real records and are
allowed. Word-like generated audio that implies speech content is decorative
invention and is banned from the map. TTS exists only inside portals as
explicit per-message playback that reads one ledger message verbatim on user
action; it never autoplays and never summarizes. Audio defaults to off; the
toggle lives in the chrome, and its state serializes into deep links as a
non-normative param (`audio=0|1`) that graders ignore.

---

## 2. Color and data palette

The viewer is the one surface where color carries data, so the token contract
is strict. Structural pixels use the neutral ramp, attention uses the brand
violet, data categories use a dedicated palette, and alarms use dedicated
semantic tokens. Every rendered color must resolve to exactly one of the tables
below; a hex that appears in none of them is a defect.

### 2.1 Substrate and structure (neutral ramp only)

Map geometry is presentation, so it never competes with data for color. All
structural glyphs draw from the shared neutral ramp on canvas `#0b0b0b`.

| Element | Token | Hex | Notes |
|---|---|---|---|
| Page / map canvas | `--sl-color-black` | `#0b0b0b` | The only page background. |
| Terrain glyph ink | `--sl-color-gray-5` | `#1a1a1a` | `·` `.` `,` backtick noise field. |
| Terrain alt ink | ramp between gray-5 and gray-4 | `#2a2724` | Checker variation only. |
| Room floor glyphs | `--sl-color-gray-4` | `#3a3632` | `.` interior fill. |
| Room walls | `--sl-color-gray-3` | `#6b6560` | `#` perimeter. |
| Corridors | `--sl-color-gray-3` | `#6b6560` | `=` runs, `+` junctions. |
| Room anchor letter | `--sl-color-gray-1` | `#d1c7b8` | The room's initial glyph. |
| Labels, primary | `--sl-color-white` | `#f3eee7` | Names on the map and in portals. |
| Labels, secondary | `--sl-color-gray-2` | `#a59d94` | Kind captions, counts, meta. |
| Panel surfaces | `--sl-color-gray-6` | `#111` | Inspector, ticker, portals. |
| Raised surfaces | `--sl-color-gray-5` | `#1a1a1a` | Cards inside portals. |
| Hairlines | `rgba(255,255,255,0.07)` | | Panel dividers. |

Rule: no structural element (terrain, wall, floor, corridor, panel, border) may
use a chromatic color. If a wall is colored, that color is claiming to encode
something, and walls encode nothing.

### 2.2 Focus (the brand accent, attention only)

| Token | Hex | May encode | Must never encode |
|---|---|---|---|
| `--viz-focus` | `#8b7cf6` | The selected element (exactly one), hover pre-selection, the "you are here" cursor in in-world tier, the live-connection status dot | Any category, any agent identity, any variable value, any verdict, more than one simultaneously selected element |
| `--viz-focus-high` | `#a78bfa` | Hover/active brightening of an already-focus element, focus ring | Body text, fills larger than a button |
| `--viz-focus-low` | `#221a3a` | Selection wash behind the selected room rect, focused-portal header tint | Text, data marks |

Violet is semantically scarce by design: it always means "look here" and never
"this kind of thing". At any instant at most one map element carries
`--viz-focus` as a selection (hover may add a second, transient, and the
live-status dot in the chrome is exempt because it is chrome, not a data mark).
Linked selection across panels highlights the same single identity, so the
one-selection rule holds globally, not per panel.

### 2.3 Categorical data palette

`--viz-cat-1..8` carries categorical identity: agents colored by team, rooms by
network, rule families, probe classes, marker families, org territories. The
palette is desaturated and luminance-matched so no category shouts, and it
excludes all three ecosystem brand hues so no data series is ever confusable
with Moltnet green `#3ddc84`, Spawnfile terracotta `#d4604a`, or Simfile violet
`#8b7cf6`.

| Token | Hex | Name | Nominal hue |
|---|---|---|---|
| `--viz-cat-1` | `#6aa4cb` | steel | 204 |
| `--viz-cat-2` | `#5cb3a9` | teal | 173 |
| `--viz-cat-3` | `#c7a26b` | sand | 36 |
| `--viz-cat-4` | `#c584b8` | mauve | 312 |
| `--viz-cat-5` | `#a9ae6a` | olive | 68 |
| `--viz-cat-6` | `#b988cf` | orchid | 281 |
| `--viz-cat-7` | `#8db77f` | moss | 105 |
| `--viz-cat-8` | `#cc82a0` | rose | 336 |

Construction rules, all checkable:

- Hue distance: every `--viz-cat-*` hue sits at least 25 degrees of HSL hue
  from each brand hue (green 145, terracotta 10, violet 250).
- Luminance match: relative luminance of every `--viz-cat-*` is within 12% of
  the palette mean, so no category is preattentively "brighter" than another.
- Saturation ceiling: OKLCH chroma stays in the 0.06 to 0.11 band; semantic
  alarm tokens (2.4) sit at 0.14 or higher, so alarms always out-saturate
  categories.
- Assignment is deterministic: categories map to tokens in stable-id sort
  order, so two viewers of one run color the same team the same way.
- Categories beyond 8 do not cycle hues; the 9th and later render in
  `--sl-color-gray-2` with glyph/label differentiation, because a cycled hue
  is a lie about identity.
- Skin `accent:` overrides for agents and `color:` for markers are clamped:
  a skin hex within 25 hue degrees of a brand hue, or out of the luminance
  band, renders with a "skin-clamped" warning chip and falls back to its
  deterministic cat token.

What categorical color may encode: team membership, network/org identity, rule
family, probe class, marker family. What it may not encode: magnitude (use the
pressure ramp), state or verdict (use semantic tokens), attention (use focus).

### 2.4 Semantic overlays (the named inferences)

These tokens exist to make VIEW_DESIGN.md Rule 1's inferences perceptual. Each
is bound to exactly one inference and appears nowhere else.

| Token | Hex | Inference | Where it may appear | Prohibitions |
|---|---|---|---|---|
| `--viz-breach` | `#e0245e` | Containment breach: a marker sighted in a scope its containment region excludes | The breaching marker glyph, its trail edge in the flow lens, the ticker row, the alert rail entry. Pulse animation allowed (1.2s ease, opacity 0.6 to 1.0) | Never a category, never a hover state, never more than the actual breach records on screen; total breach pixels stay under 1% of the map viewport unless breach records genuinely dominate |
| `--viz-delta` | `#ffc857` | Divergence: witnessed-vs-remembered diff marks, information-asymmetry marks (known-to-A-only, known-to-B-only carry `--viz-delta` on hatched sides) | Comparison lenses (head lens diff, emergence readout) and diff pins on strip charts | Never on the base map, never magnitude, never identity. In any panel where `--viz-delta` is active, categorical fills in that panel drop to neutrals so amber owns the saturated channel |
| `--viz-pressure-0..4` | `#1a1a1a` `#4a3f33` `#8a6d3f` `#c79a4c` `#e8b866` | Pressure-action causality: variable magnitude as a 5-step sequential ramp on room glows, body auras, gauge fills | Pressure lens overlays and portal strip-chart fills | Never categorical, never on more variables than the trace carries; step boundaries are the variable's own thresholds when declared, else equal quantiles of its recorded range |
| `--viz-witnessed` | `#d1c7b8` | Witnessed side of the head-lens diff | Head lens timeline, left/witnessed track | Reuses gray-1 deliberately: witnessed is "what the ledger says", plain ink |
| `--viz-remembered` | `#6b6560` | Remembered side of the head-lens diff | Head lens timeline, right/remembered track | Reuses gray-3: memory is dimmer than record. Divergence between the tracks is what `--viz-delta` marks |

Causality rendering in the pressure lens: phase bands alternate `#111` and
`#0b0b0b` backgrounds, the variable line draws in `--sl-color-gray-1`, ramp
fills under it, rule firings pin as `#f3eee7` dots at the exact crossing tick,
and the pin's ring takes `--viz-delta` only when the firing's ledger record
names that variable's threshold as its cause. The causal gesture is alignment
plus the ring, not a new hue.

Probe verdicts: passing probes render neutral (`gray-2` glyph, `gray-3`
caption); a violation is a breach-class event and takes `--viz-breach`. There
is no green "pass" color anywhere in the viewer: green is Moltnet's brand hue
and absence of alarm is the pass state.

---

## 3. Glyph and tile system

The map is a layered glyph grid (see `tileWorld.ts`). Layers compose bottom-up
and later layers overwrite cells; z-order is fixed:

```text
terrain < rooms < corridors < anchors < signals < agents
```

### 3.1 Entity glyph vocabulary

The vocabulary is closed like the crossing vocabulary. Extending it means
editing this table.

| Glyph | Class | Tone token | Backing record |
|---|---|---|---|
| `·` `.` `,` `` ` `` | terrain noise | gray-5 | none needed: terrain is declared substrate, carries no data, and is exempt from hit-testing |
| `#` | room wall | gray-3 | `viewer-trace.json` room (`scene`, `scale`, `wall_height`) |
| `.` | room floor | gray-4 | same room record |
| `=` | corridor run | gray-3 | trace corridor `path` |
| `+` | corridor junction / door | gray-3 | corridor endpoint or `doorCutters` |
| `A`..`Z` | room anchor: first alphanumeric of the room id, uppercased | gray-1 | trace room id |
| `@` | agent body | ink, or cat token when a color-by channel is active | trace agent plus a presence event placing it; agents with no presence record list in the inspector only, never on the map |
| `>` `<` `^` `v` (direction of travel) | agent in transit | same as agent, 60% opacity | `presence.in_transit` between `started_at` and `arrived_at` |
| `v` | variable signal | pressure ramp step for its current value | trace signal kind `variable` plus telemetry series |
| `*` | marker signal | marker's cat token, `--viz-breach` when breached | trace signal kind `marker`, `marker.seen` events |
| `?` | probe signal | gray-2, `--viz-breach` on violation | trace signal kind `probe`, verdict stream |
| `%` | nested-world core anchor | gray-1 | containment record for the inner run (1.1) |

Disambiguation rule: the transit glyph set and the variable glyph collide on
`v`; a `v` cell is a variable if and only if it sits on the signals layer, and
transit glyphs render only on the agents layer while an `in_transit` record is
current. Hit metadata, not the glyph, is the identity: every interactive cell
carries its `nodeId`.

### 3.2 Topology rendering

- Rooms are axis-aligned rectangles from trace `scene` and `scale`, one wall
  cell thick, with door gaps cut where corridors meet walls. Rooms never
  overlap; the deterministic layout (seeded by ids) must keep at least 2 cells
  of terrain between room rects at density 1.0.
- Corridors are orthogonal polyline runs of `=` following the trace `path`
  points, with `+` at both endpoints and at each bend. A corridor must
  terminate on a wall cell of each connected room (the door), never float.
- Agents render inside the wall rect of the room their latest presence event
  places them in, on floor cells only, packed row-major from the room center
  outward. Two agents never share a cell; overflow triggers LOD decimation
  (4.3) before overplotting is allowed.
- Signals render at their trace `scene` position; a room-scoped signal sits
  inside its room rect, a global signal sits in terrain.
- Org membranes (district band and up) render as territory outlines: a 1-cell
  dashed border in the org's cat token at 40% opacity, traced around the
  convex hull of member room rects, plus the org label. Overlapping orgs draw
  both outlines; outlines never fill.

### 3.3 Mesh and asset mapping (GlyphCSS scene mode)

When the GlyphCSS mesh scene renders instead of the flat tile grid, the same
contract holds with meshes for glyphs: rooms as extruded rects (wall height
from the trace), agents as the pawn model (`avatarModel.ts` pattern: one cached
mesh, recentered, instanced per body), skins may substitute `.vox`, `.glb`,
`.gltf`, `.obj` per stable id. Fallback is mandatory: a missing or
license-blocked asset renders the procedural primitive, never an empty cell and
never a placeholder texture. One render cycle writes each `<pre>` once; no
cell-by-cell DOM patching.

### 3.4 Labels: placement and collision

- Room labels anchor at the room rect center, offset above the anchor glyph;
  in the mesh scene they project from
  `[center.x, center.y, wallHeight * wallHeightScale + 0.34]` (the existing
  `SceneLabels` contract).
- Agent and signal labels render only for the selected element by default;
  `showLabels` widens this to rooms. Full name-tag mode (every agent labeled)
  exists only at street band and only below 40 visible agents.
- Collision rule: two visible labels may not overlap their bounding boxes.
  Resolution order when they would: (1) nudge up to 2 cells in the four
  cardinal directions, (2) drop the lower-priority label. Priority: selected >
  breach-flagged > room > agent > signal. Ties break by stable-id sort.
- A label never detaches: if its element leaves the viewport, the label goes
  with it. Off-screen selected elements get an edge chevron in `--viz-focus`,
  not a floating label.
- Every label is a hit target selecting its element (labels are buttons, as in
  `AsciiMap.tsx` and `SceneLabels.tsx` today).

---

## 4. Typography, spacing, density, LOD

### 4.1 Type

| Context | Font | Size | Notes |
|---|---|---|---|
| Map glyph cell | JetBrains Mono | `11px * density`, line-height `10px * density` | The `AsciiMap` stage variables. Density default 1.2 gives 13.2px cells |
| Map labels, primary | JetBrains Mono 700 | 12px minimum, never below 11px at any density or zoom | If a zoom level would render a label under 11px, the label drops per LOD instead of shrinking |
| Map label captions (kind, counts) | JetBrains Mono 400 | 10px minimum, `gray-2` | Captions may drop before names |
| Inspector, ticker, portal body | DM Sans | 14px body, 12px meta | Portals are HTML; text is text |
| Portal transcripts, code, ids | JetBrains Mono | 13px | event ids, scopes, ledger payloads |
| Chrome (time bar, tier chip) | JetBrains Mono | 12px | tier chip is uppercase |

### 4.2 Zoom bands

Zoom is continuous; bands switch content at cell-size thresholds (cell size =
rendered glyph cell width in CSS px):

| Band | Cell size | Content |
|---|---|---|
| street | >= 14px | bodies with speech indicators, room interiors, door gaps, per-agent selection, name tags allowed |
| building | 8 to 14px | rooms, anchors, presence counts, local gauges; agent glyphs render but labels only on selection |
| district | 4 to 8px | room rects collapse to filled blocks with headcount digits, org territory outlines on, aggregate pressure glow |
| society | < 4px | labeled cluster blobs, territory shading, breach pings only; no individual glyphs |

Band transitions must be deterministic functions of zoom value so deep links
reproduce band state exactly.

### 4.3 LOD and decimation

- Entity budget: at most 250 individually rendered agent glyphs in the
  viewport. Above that, rooms decimate to `@xN` headcount markers (one glyph
  plus a count), decimating the most crowded rooms first.
- Room budget: at most 120 labeled rooms; beyond that only selected, breached,
  and the 20 highest-salience rooms keep labels.
- Ticker: at most 200 rows mounted; older rows virtualize.
- Decimation is presentation, not filtering: every decimated entity remains
  selectable through its room's headcount marker (click opens the room's
  roster in the inspector) and remains present in hit-test accountability.
- The presence heuristic (pre-Space-Module) dims a body to 50% opacity when
  its placing record is stale by more than 20 ticks, and every
  heuristic-placed body carries the derived-state indicator (a `~` suffix on
  its label and `heuristic` in its inspector row). Trace-backed presence
  events render at full opacity with no indicator.

### 4.4 Selection and motion

- Selecting an element centers it: the camera pans (300ms ease-out, no zoom
  change) until the element is inside the central 60% of the viewport, then
  stops. Selection from the ticker, minimap, or inspector triggers the same
  centering.
- Exactly one selection exists at a time; selecting replaces. The selected
  element takes `--viz-focus` on its glyph and label; its containing room rect
  takes a `--viz-focus-low` wash. Hover shows `--viz-focus-high` outline,
  transient.
- Motion accountability: glyphs move only when records say so. Transit
  interpolates linearly along the corridor path between `started_at` and
  `arrived_at` ticks. No idle animation, no bobbing, no decorative particles.
  The only permitted animations: transit interpolation, the breach pulse,
  camera easing, and portal open/close (150ms). Everything else is static
  between ledger events.
- Live-mode tick advance repaints changed cells only; a tick with no events
  changes no pixels except the tick counter.

---

## 5. Functional criteria

What the console must do, per operator tier and per mode. "Control exists"
means visible, labeled, and operable in the chrome; "absent" means the DOM
contains no element for it (handles absent by construction, not disabled).

### 5.1 Common to all tiers and modes

- Map renders from `viewer-trace.json` (rooms, corridors, agents, presence,
  signals, ledger facts) with zero demo or fallback data. If `/api/world`
  fails or artifacts are missing, the console shows the error state naming
  `missing_artifacts`; it never renders a synthetic world.
- Inspector panel: selecting any element shows its id, kind, scope, current
  value, and the record ids backing it.
- Event ticker: salience-ranked ledger rows (probe violations and breaches >
  rule firings > wakes > chatter), filterable by kind and actor, each row
  selects its actor on click.
- Time chrome: tick counter, day/phase readout, scrub bar. All portals and
  panels follow the global time cursor; no panel may display a different tick
  than the map.
- Deep links: the current view serializes to a v1 URL (1.4) and any v1 URL
  restores camera, time, selection, portal stack, lenses, and tier.
- Skin picker: switching skins changes presentation only; node positions,
  counts, and ledger content are identical across skins.
- Render settings: density, room scale, agent scale, label toggle (the
  `RenderSettings` surface), all presentation-only.
- Fog-of-war lens: pick an agent, and the map dims rooms outside its
  memberships to silhouettes (structure visible, anchors and bodies hidden),
  portals it lacks scope for refuse to open with a scope-named refusal, and
  only its own head portal is enterable. Implemented as the shared scope
  predicate; available in every tier because it is a lens, not a permission.

### 5.2 Observer tier (default)

- Free camera, all scopes visible, all portals openable, all lenses available.
- Zero write surface: no pause, step, wake, seed, or speech control exists in
  the DOM. The HTTP client holds no write-capable endpoint handles.
- Mode chip reads `OBSERVER` in the chrome, gray border treatment.

### 5.3 In-world tier

- Requires explicit elevation with a Moltnet credential; the viewer never
  escalates silently.
- The human takes a body via `human_ingress`: a presence appears, the camera
  binds to it (third-person follow, detachable back to free-look with an
  explicit "leave body" control), and a speech input exists for rooms the
  body is present in, proxied through Moltnet.
- The body's glyph carries the `--viz-focus` "you are here" ring, the one
  standing exemption to selection exclusivity (cursor and selection may
  coexist).
- Frame border takes a 2px `--viz-focus` treatment and the chip reads
  `IN-WORLD`. Speech is the only write; everything else stays observer-shaped.

### 5.4 Operator tier

- Requires explicit elevation with the operator credential.
- Controls that exist: pause, resume, single-step (one tick), manual wake of a
  named agent, seed inspection. Each proxies to an existing operator endpoint;
  the viewer adds no write path of its own.
- Every operator action is ledgered with `provenance: external` and renders
  in-world as a visible intervention event (ticker row plus a map flash on the
  affected scope, using neutral ink, not violet and not breach red).
- Pause state is unmistakable: the time chrome shows `PAUSED (operator)`, and
  the pause record's event id is displayed. Stepping advances exactly one tick
  per activation.
- Frame chip reads `OPERATOR` with a `--viz-delta`-toned border (amber,
  because the operator hand is a divergence source in the record).

### 5.5 Source tier

- Deep-links out to files (fixture Simfile, skin manifests, run artifacts) in
  the editor; the viewer itself edits nothing and gains no write surface.
- Chip reads `SOURCE`; every outbound link names its absolute target path.

### 5.6 Live mode

- Attaches to `--state .sim/`: SSE ledger tail, telemetry stream, probe
  verdict stream, Moltnet proxy. "Now" follows the stream head by default.
- Rewinding the scrub bar rewinds the view only, never the world; a `LIVE`
  chip with the `--viz-focus` status dot shows stream attachment, switching to
  `BEHIND <n> ticks` when scrubbed back, with a one-click "return to now".
- Alert rail streams probe verdicts; a violation raises a breach-toned rail
  entry within one tick of its record.
- Stream loss shows a reconnect state and stamps the gap; it never freezes
  silently or interpolates missed ticks.

### 5.7 Replay mode

- Points at a sealed run directory; "now" is the final event, no SSE opens.
- Scrub, play, and speed controls (0.5x, 1x, 4x, 16x); play advances the time
  cursor through ledger order deterministically.
- Live/replay parity: the same run viewed live and replayed from its export
  renders identical scene state at matching ticks.
- Replay never mutates anything: the run directory is opened read-only.

---

## 6. Motion and attention layer specs

- Salience ranking is fixed by class, in this order: probe violation, marker
  breach, operator intervention, rule firing, wake, presence change, message.
  The order is not configurable and not learned.
- Minimap pings: breach-class events ping in `--viz-breach`, all other salient
  classes ping in `gray-1`; pings decay over 2s and never stack more than 3
  deep per tile.
- "Jump to activity" targets the highest-salience event in the last 50 ticks.
- Camera bookmarks: save/restore named poses, serialized in deep links only
  when explicitly pinned.
- The breach pulse is the only looping animation in the product.

---

## 7. Completion criteria (B49 acceptance checklist)

The B49 gate is a Playwright run over the sealed autonomous-office run record
(replay) and a live-like session, producing screenshots, a render report, and
this checklist. Every item is a yes/no assertion; the gate passes only when
all items pass. "Office-run density" means the full
`autonomous-office-sim` fixture trace with all agents present.

### 7.1 Pixel accountability

- [ ] A1: Every interactive map element (agent, room, corridor endpoint,
  signal, anchor, label) resolves on hit-test to at least one record id from
  `viewer-trace.json`, the ledger, telemetry, or the compile report, exposed
  in the inspector when selected.
- [ ] A2: No fallback or demo data renders anywhere: with `/api/world`
  unreachable, the DOM contains the error state and zero map nodes.
- [ ] A3: Agents without presence records appear in the inspector list and do
  not render as map bodies.
- [ ] A4: Every heuristic-placed body carries the derived-state indicator; no
  trace-backed body carries it.
- [ ] A5: During a 100-tick replay segment with no events for agent X, agent
  X's glyph position is identical in before/after screenshots (no invented
  motion).

### 7.2 Color contract

- [ ] C1: Computed styles of all map data marks resolve only to hexes defined
  in section 2 tables (substrate neutrals, focus trio, cat 1..8, semantic
  overlay tokens).
- [ ] C2: `#8b7cf6` (and `#a78bfa`, `#221a3a`) appears only on the selected
  element, hover outline, selection wash, in-world cursor ring, and the live
  status dot; at no instant do two non-hover, non-cursor elements carry
  focus violet simultaneously.
- [ ] C3: No data mark (agent, room fill, signal, trail, chart series) uses
  `#3ddc84`, `#d4604a`, or `#8b7cf6`.
- [ ] C4: All categorical marks use `--viz-cat-1..8` values; category-to-token
  assignment is identical across two fresh loads of the same run.
- [ ] C5: Every `--viz-cat-*` hue measures at least 25 HSL degrees from hues
  145, 10, and 250, and relative luminance spread across the 8 tokens is
  within 12% of the mean (assert against the literal hexes in 2.3).
- [ ] C6: `--viz-breach` `#e0245e` appears only when a breach or violation
  record exists in the visible time range; a run segment with zero breach
  records shows zero breach-colored pixels.
- [ ] C7: `--viz-delta` appears only inside comparison lens panels and pin
  rings, never on the base map.
- [ ] C8: Structural elements (walls, floors, corridors, terrain, panels)
  compute to neutral ramp values only.
- [ ] C9: No green "pass" indicator exists; passing probes render in neutrals.

### 7.3 Glyph and topology

- [ ] G1: The rendered glyph vocabulary is exactly the section 3.1 table; a
  DOM scan of map cells finds no glyph outside it (terrain set included).
- [ ] G2: Every room rect is closed (contiguous wall perimeter) with door gaps
  only where a trace corridor meets the wall.
- [ ] G3: Every corridor terminates on room walls at both ends; no floating
  corridor cells.
- [ ] G4: Every agent glyph sits on a floor cell inside its placing room's
  rect; no two agents share a cell at office-run density.
- [ ] G5: Layer z-order matches section 3: an agent cell overwrites a signal
  cell overwrites an anchor cell at the same position.

### 7.4 Labels and legibility

- [ ] L1: At office-run density and default zoom, every visible label's
  computed font-size is at least 11px.
- [ ] L2: No two visible labels' bounding boxes intersect at office-run
  density in default, building, and street bands (screenshot plus DOM rect
  assertion).
- [ ] L3: Label priority holds: forcing a collision (dense corner selection)
  drops the lower-priority label per section 3.4, deterministically across
  reloads.
- [ ] L4: Room labels remain legible (>= 11px, non-overlapping) after
  density and room-scale sliders are set to extremes; if a setting would
  violate this, labels drop rather than shrink.
- [ ] L5: The selected element, when scrolled off-screen, produces the edge
  chevron and no floating label.

### 7.5 Selection, time, and links

- [ ] S1: Selecting any element from map, ticker, minimap, or inspector
  centers it into the central 60% of the viewport within 400ms and applies
  focus styling to exactly that element in every panel.
- [ ] S2: Scrubbing with an open portal keeps portal tick and map tick equal
  at every sampled position (assert equality of displayed tick values).
- [ ] S3: A serialized deep link reopened in a fresh context reproduces
  camera pose (to 2 decimals), time cursor event id, selection, portal
  stack, lenses, and tier; pixel-diff of the two screenshots is under 0.5%.
- [ ] S4: The same deep link opened against a regenerated export of the same
  run reproduces the identical view (anchor is run_id + event_id).
- [ ] S5: Replaying the sealed run twice produces identical scene DOM at 5
  sampled ticks (deterministic seeded layout).

### 7.6 Modes and tiers

- [ ] T1: Observer DOM contains zero write-capable controls (no pause, step,
  wake, or speech elements exist, not merely disabled).
- [ ] T2: The active tier chip is visible in every screenshot, and tier
  changes require the explicit elevation flow.
- [ ] T3: In live-like mode, pausing as operator writes a ledger event with
  `provenance: external`, the chrome shows `PAUSED (operator)` with the event
  id, and single-step advances exactly one tick.
- [ ] T4: Fog-of-war for a chosen agent renders no content (bodies, anchors,
  labels, ticker rows, portal contents) outside that agent's scopes, and
  out-of-scope portals refuse with a scope-named message.
- [ ] T5: Live and replay renders of the same run match at 3 sampled ticks
  (parity screenshots, pixel-diff under 0.5% excluding the mode chip and
  stream status chrome).
- [ ] T6: Rewinding the live view shows `BEHIND <n> ticks` and never issues a
  write; "return to now" reattaches to the stream head.

### 7.7 Density and performance

- [ ] D1: At office-run density, initial render to interactive map is under
  2s on the reference machine, and scrub steps repaint in under 100ms.
- [ ] D2: With a synthetic 300-agent trace, decimation engages (headcount
  markers appear), no cell overplots, and every decimated agent remains
  reachable via its room roster.
- [ ] D3: A tick with no events changes no map pixels except time chrome
  (screenshot diff).
- [ ] D4: The GlyphCSS scene writes each `<pre>` once per render cycle (no
  cell-level DOM mutation observed during a 50-tick playback).

### 7.8 Gate artifact

- [ ] R1: The acceptance run writes an artifact folder containing: replay
  screenshots per zoom band, live-like screenshots, the deep-link round-trip
  pair, the fog-of-war pair, the render report (band, density, label, and
  palette measurements), and this checklist with every item marked and each
  mark traceable to a named screenshot or assertion log.

A criterion that cannot be evaluated (missing fixture, missing mode) fails
closed: unevaluated items count as failures, not skips.
