# Simfile Documentation Site: Design Spec and Docs IA

Canonical spec for the Simfile public site (`ecosystem/simfile/website/`): the
landing page, the visual language, the navigation, and the full documentation
information architecture with per-page content outlines.

Sources of truth, in priority order:

1. `../../ECOSYSTEM-DESIGN.md`: the shared Noopolis design system. This spec
   applies it; it never overrides it.
2. `DESIGN.md` and `VIEW_DESIGN.md`: what the product is. No page may invent
   schema keys, commands, or viewer behavior that these documents do not back.
3. `../moltnet/website/`: the reference implementation of the site foundation.
   Simfile's site must read as a first-class sibling: same structure, same
   polish, same component grammar, different accent and content.

Brand facts, confirmed (encode, do not revisit):

- Shared Noopolis system: dark-mode-only posture, the neutral ramp on `#0b0b0b`,
  DM Sans + JetBrains Mono (Fraunces for landing display headings only),
  Starlight defaults, the shared mermaid styling.
- Simfile accent: **violet**. `--sl-color-accent: #8b7cf6`,
  `--sl-color-accent-high: #a78bfa`, `--sl-color-accent-low: #221a3a`.
- Selection: violet on `#0b0b0b` (`::selection { background: #8b7cf6; color: #0b0b0b; }`
  plus the `::-moz-selection` twin).
- Wordmark: `sim` in ink, `file` in violet, JetBrains Mono 700.

Migration note: the current `website/src/styles/custom.css` carries a teal trio
(`#4bbfb5` family) and the landing uses `theme-color #090d0e`. Both are
pre-system leftovers. The accent block is replaced by the violet trio, the
theme color becomes `#0b0b0b`, and the rest of `custom.css` converges on
byte-equivalence with Moltnet's outside the accent block, per the ecosystem
spec.

---

## Part A: Site Design Spec

### A1. Landing page (`src/pages/index.astro`)

The landing mirrors Moltnet's landing beat for beat: fixed nav, hero with copy
left and visual right, an install chip, a two-step "prologue + proof" demo
frame, three explanatory sections, a CTA band, a thin footer. Only the accent,
the copy, and the demo content differ.

#### Hero

- **Eyebrow** (mono, violet, uppercase): `Deterministic world kernel for agent societies`.
- **Headline** (Fraunces, ink, violet italic `em`), sibling symmetry with
  Moltnet's "Give your agents a place to talk.":

  > Give your agents a world that <em>pushes back.</em>

  Acceptable variant if the em placement fights the line break:
  "Declare the world. <em>Replay everything.</em>"
- **Subhead** (gray-1, max ~46ch), grounded in the ECOSYSTEM.md thesis (CI for
  agent societies, deterministic world around nondeterministic minds):

  > Your agents already think. Simfile gives them time, pressure, stimuli, and
  > measurement: a deterministic world with a seeded clock, falsifiable probes,
  > and byte-identical replay. The world is deterministic; the society is not.
  > That is the point.
- **Actions**: primary violet-fill button `Install Simfile` linking `/install/`,
  outline button `Quickstart` linking `/quickstart/`. If npm publish has not
  happened when the page ships, the primary CTA becomes `Quickstart` and the
  install chip is dropped until the command is real (honest-status rule, B).
- **Install chip** (only when real): `npm install -g simfile` with the copy
  button; copied state turns violet. Note line: `One package: schema, kernel, CLI, and viewer.`

#### First-viewport visual: a static GlyphCSS viewer still

Recommendation: a **hand-built HTML/CSS still of the viewer**, upgrading the
console mock already in `index.astro`, not an animated world snippet and not a
screenshot.

- Frame: a demo pane (`--sl-color-gray-6` chrome, hairline border, 10px radius)
  titled `simfile view runs/office-014` with the three window dots.
- Left pane: the GlyphCSS map still. Four glyph rooms (office hall, case
  warroom, eleanor home, street), agent dots, one room carrying a visible
  pressure gauge (`filing_pressure 0.71`). Violet appears exactly once: the
  focused room's outline (the "you are here" semantics from VIEW_DESIGN rule 3
  and the viewer bridge rule in ECOSYSTEM-DESIGN section 6).
- Right pane: a focus portal transcript with timestamped lines, one
  `wake.recommended` line in violet, one `probe pressure_peaked PASS` line
  using Starlight's success semantics (green), never the brand accent.

Why a still and not animation: the hero must load instantly, must be honest
(no invented motion; pixel accountability is the product's own rule), and
Moltnet's hero slot is also a static illustration. Motion belongs one scroll
below, in the proof frame, exactly where Moltnet animates.

#### Prologue + proof frame (below the hero, Moltnet's pattern verbatim)

- **Prologue** (Step 1, "Author the world"): a one-line command strip,
  `$ simfile validate ./Simfile`, meta line `world valid · seed office-run-014`
  with the violet live dot.
- **Proof** (Step 2, "Run it deterministically"): three-column row.
  - Left: a short Simfile YAML excerpt (clock + one rule), highlight grammar
    with violet keywords and prompts, gray-1 values, gray-3 hints. One animated
    span: the `seed:` value typewrites as the pills cycle.
  - Center arrow: `$ simfile run ./Simfile --ticks 144` with the compiling
    shimmer on cycle.
  - Right: the run-record checklist revealed item by item:
    `✓ ledger.jsonl` · `✓ telemetry.json` · `✓ report.json` ·
    `✓ viewer-trace.json`, then the run line `viewer at :18787`.
  - Pills under the left pane cycle **fixtures, not runtimes** (Simfile's
    variable is the world, Moltnet's was the agent system): `office-world`,
    `repeated-dilemma`, `tiny-world`. Clicking a pill swaps the YAML excerpt
    name/seed and replays the reveal. Every pill must correspond to a fixture
    that exists in `fixtures/`.
- **Proof bar**: left `same seed, same ledger` · `jsonl | sqlite` ·
  `replay from any run record`; right `simfile v0.1`.

#### Section flow (what the landing communicates, in order)

| # | Section | Message | Moltnet parallel |
|---|---------|---------|------------------|
| 1 | Hero + still | What it is, in one screen: declared world, live instrument | Hero + illustration |
| 2 | Prologue + proof | The core loop is three commands and it is deterministic | `moltnet init` + runtime-switch proof |
| 3 | `#how` How it works | Three steps: the world speaks, agents answer, the ledger judges | "Your agents don't need native Moltnet support" |
| 4 | `#kernel` The kernel | Seven primitives, zero domain nouns, one YAML file | Agent systems section (the "what's inside" slot) |
| 5 | `#viewer` The viewer | Map + portals, every pixel backed by a record | Platform matrix (the "depth proof" slot) |
| 6 | CTA band | "Worlds you can rerun." Install / Read the docs | CTA band |
| 7 | Footer | `simfile v0.1 · pairs with spawnfile · talks through moltnet`, Docs / Schema / GitHub | Footer |

Section 3 content, three step cards with mini code panes:

1. **The world speaks**: a rule fires, `@world` posts to a Moltnet room.
   The world is a participant, not a puppeteer.
2. **Agents answer freely**: runtimes wake and reply through their normal
   bridges. Nothing scripts a thought.
3. **The ledger judges**: every act lands in a seeded, replayable ledger;
   probes turn claims into verdicts with evidence.

Section 4 content: a seven-tile primitives grid (clock, variables, generators,
rules, events/ledger, probes, entity lifecycle) with one-line definitions;
entity lifecycle visibly badged `reserved until v3`. Beside it, the minimal
world YAML (clock-only `tiny-world`) proving "the file grows with world
richness, never with boilerplate."

Section 5 content: three panels (Map first / Portals / Accountable pixels) and
one honest capability line stating exactly what `simfile view` renders today,
sourced from the Live vs Replay doc page (B section, viewer pages).

#### Head parity

Match Moltnet's `<head>` discipline: canonical URL (`https://simfile.dev/`),
sitemap link, OG + Twitter cards with a rendered `og.png`, favicons, JSON-LD
(`WebSite`, `SoftwareSourceCode`, `SoftwareApplication`, and an `FAQPage` with
4 or 5 real questions: what is Simfile, is the world deterministic if agents
are LLMs, does it script agents, does it need Spawnfile, what does the viewer
show). Analytics only if/when a property exists. Keep the
`generate-llms-txt.mjs` post-build step.

### A2. Visual language

#### Token application

Everything in ECOSYSTEM-DESIGN section 2 applies unchanged: neutral ramp,
fonts, dark-only posture (`color-scheme: dark`, no theme toggle; keep the
existing `EmptyThemeSelect.astro` override). The per-site delta is exactly five
declarations: the three violet accent tokens and the two selection rules.

Where violet appears (and nowhere else):

- links and active nav / active sidebar item (via Starlight accent tokens);
- focus rings and selection;
- the primary CTA fill (violet fill, `#0b0b0b` text, violet shadow at 0.25);
- kickers, step tags, wordmark `file` span, live dots, checkmarks;
- code-pane highlight grammar: keywords, prompts, success glyphs in demo panes;
- the viewer's focus semantics wherever the site shows viewer imagery: the
  focused membrane outline, the selected scope, the "you are here" glyph.

Where violet is banned (restraint rules):

- never a data category: agents, rooms, rule families, and probe classes in any
  chart or viewer still use the viz categorical palette (`VIEW_STYLEGUIDE.md`),
  which excludes all three brand hues;
- never a state color: probe PASS/FAIL, cautions, and errors use Starlight
  aside semantics (`:::note` / `:::tip` / `:::caution` / `:::danger`), not the
  accent;
- never body text; `accent-high` is hover brightening only, `accent-low` is
  tint fills only;
- glows at or below 0.25 alpha for anything larger than a button; hero radials
  near 0.18.

#### Code blocks and mermaid

Inherit Moltnet's exactly. Docs code: Starlight/Expressive Code defaults with
`--sl-font-mono`. Landing demo panes: `rgba(0,0,0,0.3)` or gray-5 background,
hairline border, 10px radius, ~0.78rem mono. Mermaid: the shared
`pre.mermaid` block from ECOSYSTEM-DESIGN section 4 verbatim (transparent
background, system-ui labels, gray-3 base ink); emphasize a node by stroking it
violet, at most one emphasized node per diagram.

#### Simfile-specific components (the only additions to the shared kit)

1. **Viewer still**: the hero component above, reused at smaller scale on the
   viewer guide and skins guide. Pure HTML/CSS, no iframe, no screenshot rot.
2. **Primitives grid**: the seven-tile component from landing section 4,
   reused as the opener of the Architecture reference.
3. **Verdict badge**: a small mono pill for probe outcomes in docs examples,
   `PASS` in Starlight success green, `FAIL` in Starlight danger red, never
   violet. Shares the pill anatomy from ECOSYSTEM-DESIGN (999px radius,
   hairline border).
4. **Status badge** for the honest-status rule: mono pills `implemented`,
   `experimental`, `planned` rendered gray-3 with a hairline border;
   `implemented` gets the violet dot. Used in CLI and reference pages.

### A3. Nav and sidebar IA

Landing nav (fixed, `rgba(11,11,11,0.85)` + blur, hairline bottom border):

```text
sim|file        How · Kernel · Viewer · Docs        [GitHub corner]
```

`How` → `#how`, `Kernel` → `#kernel`, `Viewer` → `#viewer`, `Docs` →
`/introduction/`. Add the ink-on-black GitHub octocat corner once the repo URL
is public.

Docs sidebar (Starlight defaults, no custom sidebar CSS; accent tokens light
the active item). Three groups, mirroring Moltnet's Getting Started / Guides /
Reference:

```text
Getting Started
  Introduction
  Install
  Quickstart
  Concepts

Guides
  Your First World
  The Office World
  Repeated Dilemma
  Spawnfile Integration
  The Viewer
  Live vs Replay
  Skins
  Designing Experiments

Reference
  Simfile Schema
  CLI
  Architecture
  Ledger & Telemetry
  Probes & Markers
  Viewer API
```

18 pages total (4 + 8 + 6) against Moltnet's 23 (4 + 8 + 11): matched guide
depth, a leaner reference set because Simfile has no HTTP API, auth, or
pairing surface yet. Reference grows only when surface ships.

---

## Part B: Docs IA and Content Outline

### The honest-status rule (normative for every page)

Every command, flag, endpoint, or behavior a page advertises must be runnable
from the shipped package at publish time, or carry an explicit badge:
`experimental` (exists, unstable contract) or `planned` (does not exist, cite
the DESIGN.md layer: v1 planning, v2 world runtime, v3 governance). Planned
commands live only in clearly-marked "Planned" sections, never in copy-paste
flows.

Post-burn maturity baseline the pages must state (verify against the repo at
publish; downgrade any claim the code does not back):

- **Schema**: v0.1 kernel schema and validator, implemented and stable.
  Domain-noun lint enforced. Lexical shorthands (`range: 0..1`, durations)
  expand in the lexer.
- **Runtime**: seeded finite runs via `simfile run --ticks N`, implemented.
  Deterministic mechanical stream, sealed run records (`manifest.yaml`,
  `ledger.jsonl`, `telemetry.json`, `report.json`, `viewer-trace.json`).
  Mechanical probes and marker scanning evaluate in the run report;
  conversation probes and the quality rubric are burn deliverables
  (B31b/B32): state them only if landed, else badge `experimental`.
  There is no long-running world daemon, no `clock pause/resume`, no
  standalone `ledger`/`status`/`probes`/`report`/`doctor`/`plan`/`dev`
  commands: all `planned`.
- **Viewer**: `simfile view` implemented for replay (run record dir) and for
  tailing a state directory (`--state`, `--port`, `--no-open`), serving the
  GlyphCSS console with `/api/state`, `/api/skins`, `/api/events`.
  Evidence click-through and operator controls are burn deliverables
  (B36/B51): same verify-or-badge rule. `--skin` and `--moltnet` flags are
  future surface (VIEW_DESIGN), never advertised as current.
- **Live mode**: "live" means tailing a producing state directory during a
  harness or runtime run. There is no always-on world service; no page may
  imply one.

### Page inventory

Status legend: `exists` (keep, light edits) · `rewrite` (page exists, content
rebuilt to this outline) · `NEW`.

| Page | Status | Moltnet parallel | Purpose (one line) |
|------|--------|------------------|--------------------|
| `introduction.md` | rewrite | `introduction.md` | What Simfile is, the determinism claim stated precisely, stack position |
| `install.md` | NEW | `install.md` | Get a working `simfile` binary honestly: npm when published, from source today |
| `quickstart.md` | rewrite | `quickstart.md` | Validate → run → view a tiny world in five minutes, all commands real |
| `concepts.md` | rewrite | `concepts.md` | The mental model: world vs minds, seven primitives, provenance, five truths |
| `guides/first-world.md` | NEW | `guides/running-local.md` | Author a world from a clock-only file to variables, generators, rules |
| `guides/office-sim.md` | NEW | `guides/public-demo-network.md` | The flagship genre fixture, walked end to end |
| `guides/repeated-dilemma.md` | NEW | `guides/pairing-networks.md` (slot: second full scenario) | The second genre fixture; proves genre neutrality and the two-fixtures rule |
| `guides/spawnfile-integration.md` | rewrite | `guides/runtimes-and-attachments.md` | Run a world around a compiled org via the resolved graph report |
| `guides/viewer.md` | rewrite (from `guides/live-viewer.md`) | `guides/console-ui.md` | Drive the viewer: map, portals, lenses, what each pixel means |
| `guides/live-vs-replay.md` | NEW | `guides/operating-moltnet.md` | The two viewer modes and the run-record lifecycle; what "live" honestly means |
| `guides/skins.md` | rewrite | `guides/console-ui.md` (presentation slot) | Presentation packs: reskinning worlds without touching the schema |
| `guides/experiments.md` | NEW | `guides/securing-remote-agents.md` (slot: guarantees guide) | Design falsifiable experiments with markers, probes, and seeds |
| `reference/simfile.md` | rewrite | `reference/node-config.md` + `reference/configuration.md` | Complete schema reference: every key, every enum, canonical forms only |
| `reference/cli.md` | rewrite | `reference/cli.md` | Every command and flag with status badges; planned layers separated |
| `reference/architecture.md` | NEW | `reference/architecture.md` | The kernel: tick pipeline, determinism contract, boundaries and refusals |
| `reference/ledger-and-telemetry.md` | NEW | `reference/storage-and-durability.md` + `reference/message-model.md` | Event kinds, provenance, scope grammar, canonical export, stores, run records |
| `reference/probes-and-markers.md` | NEW | `reference/runtime-capabilities.md` (slot: guarantees matrix) | The verdict layer: `when`/`expect`, marker modes, compiled probes, evidence |
| `reference/viewer.md` | NEW | `reference/http-api.md` | The viewer's read-only HTTP surface and the run-record contract for third parties |

Gaps this closes versus today's 8 pages: no install page, no architecture
reference, no ledger/telemetry reference, no probes/markers reference, no
genre guides, no live-vs-replay guide, no experiment-design guide, and a
schema page that stops at the clock.

### Per-page outlines

Format: purpose · required section headings · the status line the page must
carry.

#### Getting Started

**`introduction.md`** (rewrite)
Purpose: define Simfile in one screen and state the determinism claim so
nobody over-reads it.
Sections: `What Simfile Is` · `The Determinism Claim` (world deterministic,
society not; mechanical vs pinned inputs) · `Stack Position` (mermaid: the
Spawnfile/Moltnet/Mneme/Daimon diagram, Simfile node stroked violet) ·
`The Kernel` (seven primitives, one line each) · `What Simfile Is Not`
(no game engine, no metric space, no populations, no agent scripting) ·
`Where To Go Next`.
Status line: schema and validator implemented; runtime runs seeded finite
worlds; entity lifecycle reserved until v3.

**`install.md`** (NEW)
Purpose: a copy-paste path to a working `simfile` command with zero dishonest
steps.
Sections: `Requirements` (Node version) · `Install from npm` (only if
published; otherwise this section opens with the publish status and defers to
source) · `Install from Source` (clone, install, build, link) · `Verify`
(`simfile --help`, `simfile validate` on a fixture) · `Upgrade` ·
`Troubleshooting`.
Status line: npm publish state stated explicitly on the page; the from-source
path is always current.

**`quickstart.md`** (rewrite)
Purpose: first success in five minutes using only implemented commands.
Sections: `Create a World` (the clock-only `tiny-world`) · `Validate It` ·
`Run It` (`simfile run ./Simfile --ticks 144 --out runs/first`) · `Open the
Viewer` (`simfile view runs/first`) · `What Just Happened` (the run record
files, one line each) · `Next Steps` (first-world guide, office guide).
Status line: every command on this page is implemented; no planned surface
appears here at all.

**`concepts.md`** (rewrite)
Purpose: the mental model that makes every other page short.
Sections: `World, Not Mind` · `The Seven Primitives` (primitives grid
component) · `Determinism and Provenance` (mechanical / agentic / external;
byte-identical replay scope) · `One Clock, Two Times` (tick vs `sim_per_tick`,
phases) · `Rules Are the Only Reactive Construct` (`when:` + `do:`,
`fire: once` vs `per_crossing`) · `Measures Drive, Probes Judge` (sensor vs
verdict vocabulary) · `The Five Truths` (where Simfile's world truth sits) ·
`Scopes` (the shared scope grammar).
Status line: conceptual page; every construct shown is schema-valid v0.1.

#### Guides

**`guides/first-world.md`** (NEW)
Purpose: teach authoring by growing one file from nothing to a living world.
Sections: `Start with a Clock` · `Add Pressure` (a variable with range and
initial) · `Make It Move` (deterministic generator, then a stochastic one,
then relaxation as the `delta_eq` idiom) · `Make It React` (a threshold rule
posting world speech; placeholder substitution) · `Make a Claim` (one probe) ·
`Run and Read the Report` · `Authoring Rules of Thumb` (id-keyed maps, no
sugar, domain nouns are values).
Status line: end-to-end on implemented surface (`validate`, `run`, `view`).

**`guides/office-sim.md`** (NEW)
Purpose: the flagship worked example; the page a newcomer forwards to explain
the product.
Sections: `The Scenario` · `The World File` (annotated office Simfile:
phases, filing_pressure, hall_heat measure, story rules, markers) · `The
Organization` (pointer to the Spawnfile fixture, not a duplicate) · `Running
It` · `Reading the Run` (ledger excerpts, marker verdicts, the containment
story) · `Replaying It` · `Variations` (change the seed, change a threshold).
Status line: mirrors the shipped office fixture; measured variables and any
conversation-quality probes shown must match what the run report actually
emits, else badge `experimental`.

**`guides/repeated-dilemma.md`** (NEW)
Purpose: the second genre, proving the schema is genre-neutral and the
two-fixtures rule is honored.
Sections: `Why a Second Genre` (the two-fixtures rule) · `Payoffs as World
State` (variables and ledgered outcomes; every defection is an event) · `The
World File` · `Probes as Hypotheses` (cooperation claims as `expect`
primitives) · `Running Ensembles Honestly` (seeds vary the world; agent
behavior ensembles need lockstep mode, badge `planned`).
Status line: fixture-backed; lockstep mode is designed, deferred, and labeled
as such.

**`guides/spawnfile-integration.md`** (rewrite)
Purpose: compose a world with a compiled organization without duplicating
either.
Sections: `The Boundary` (Simfile never re-parses Spawnfile YAML) · `The
Resolved Graph Report` (`spawnfile compile --report-json`, then
`--spawnfile-report` on validate/run) · `Binding Checks` (agents, teams,
rooms verified against the report) · `The World as a Participant` (`@world`
credential, no private wake path) · `A Full Local Flow` (compile, up, run,
view) · `Planned: simfile dev` (badge `planned`, v2; prints its Spawnfile
command first).
Status line: `--spawnfile-report` is implemented on `validate` and `run`;
`plan` and `dev` are planned.

**`guides/viewer.md`** (rewrite of `guides/live-viewer.md`)
Purpose: teach someone to drive the instrument and read it critically.
Sections: `Open a Run` · `The Map` (GlyphCSS scene, semantic zoom bands,
presence heuristic labeled as a heuristic) · `Portals` (rooms, heads, docs;
breadcrumbs; time-linked scrubbing) · `Lenses and Selection` (linked
selection across projections) · `Accountable Pixels` (point at anything, get
the records; evidence click-through if landed, else `experimental`) ·
`Operator Controls` (only if landed: pause/resume/step, ledgered as external;
else `planned`) · `Ports and Flags` (`--port`, `--no-open`).
Status line: replay console implemented; each interactive capability badged
individually against the shipped viewer.

**`guides/live-vs-replay.md`** (NEW)
Purpose: kill the ambiguity in the word "live" and document the run-record
lifecycle.
Sections: `Two Modes, One UI` · `Replay` (sealed run directory; "now" is a
fixed end tick) · `Live` (tailing a producing `--state` directory; what
updates and how) · `What Live Is Not` (no always-on world daemon; the clock
belongs to the run, not the viewer) · `The Run Record` (directory layout,
manifest, canonical export) · `From Live to Sealed` (how a run becomes a
replayable record) · `Determinism in Practice` (same seed, same mechanical
stream; agentic events replay as inputs).
Status line: this page is the site's single source of truth for live-mode
maturity; other pages link here instead of restating it.

**`guides/skins.md`** (rewrite)
Purpose: reskin worlds as presentation packs without touching simulation
semantics.
Sections: `Presentation Never Enters the Schema` (rule 4) · `The Default
Skin` (the tile/glyph console) · `What a Skin Maps` (stable ids to visual
anchors; auto-layout when unskinned) · `Building on the Viewer Data` (skins
read run artifacts only) · `Planned Tooling` (`simfile skin init/validate/
preview/pack`, all badged `planned`) · `Asset Rules` (licensed, replaceable,
tracked).
Status line: the default console skin ships; skin tooling does not exist yet.

**`guides/experiments.md`** (NEW)
Purpose: turn "the agents seemed to cooperate" into a graded, falsifiable
claim; the page that sells Simfile to researchers.
Sections: `Claims, Not Vibes` · `Markers Are Tracer Dye` (containment vs
propagation; declaration, not planting; literal text only) · `The Compiled
Probes` (planted/contained/reached; the vacuous-pass guard) · `Writing Probes`
(`when` + `expect`, `after`/`within` windows, worked examples) · `The Claim
Boundary` (v0 detects literal leakage only; paraphrase is analysis-layer,
never a kernel verdict) · `Seeds and Reruns` (what replay does and does not
re-experiment) · `Reading Evidence` (verdicts carry event ids).
Status line: marker scanning and mechanical probe evaluation run in the run
report today; streaming `--follow` probes are planned (v2).

#### Reference

**`reference/simfile.md`** (rewrite)
Purpose: the complete, canonical schema reference; if a key is not here, it
does not exist.
Sections: `File Conventions` (named `Simfile`, YAML, id-keyed maps, one
reactive form, lexical shorthands) · `Top-Level Keys` · `clock` · `variables`
(driven / measured / fed / derived; measure kinds table; scopes) ·
`generators` (deterministic `delta`/`delta_eq`/`set_eq`, stochastic
distributions, `when:` gating) · `The eq Grammar` (operands, operators,
frozen function list, totality rules, duration literals) · `rules` (`when:`
atoms and composition, `fire:`, the action registry table, placeholders) ·
`ledger` (store kinds) · `telemetry` · `markers` · `probes` (`expect`
primitives, `after`/`within`) · `Validation Errors` (former sugar keys,
bare-list `when:`, reserved builtins) · `Reserved` (`spawnfile:` pointer,
entity lifecycle v3).
Status line: documents exactly the shipped v0.1 schema; every example
validates against the current validator (CI-checkable).

**`reference/cli.md`** (rewrite)
Purpose: every command and flag, statused; the honest-status rule made into a
table.
Sections: `Implemented` (`validate` with `--json`/`--spawnfile-report`; `run`
with `--ticks`/`--out`/`--seed`/`--run-id`/`--moltnet-artifact`/
`--spawnfile-report`; `view` with `--state`/`--port`/`--no-open` and the
run-dir form; exact output files listed) · `Exit Codes` · `Planned: v1
Planning` (`plan`, `diff`, `doctor`, `inspect`, `explain`) · `Planned: v2
World Runtime` (`status`, `clock`, `ledger`, `probes --follow`, `report
--collect`, `runs`, `dev`) · `Planned: v3 Governance` (`propose`,
`proposals`, `patch`, `pr`).
Status line: the Implemented section is the only copy-paste surface; planned
sections carry the layer badge and cite DESIGN.md.

**`reference/architecture.md`** (NEW)
Purpose: how the kernel works, precisely enough to trust the replay claim.
Sections: `The Seven Primitives` (primitives grid) · `The Tick Pipeline`
(mermaid, violet stroke on the current stage: signals → deltas → measures →
derived → rules → flush; lexicographic and topological ordering) · `The
Determinism Contract` (seeded streams via `SHA-256(run_seed:generator_id:
tick:draw_index)`, fixed precision, canonical export rules, float/
transcendental policy) · `Provenance and Replay Scope` · `World-to-Agent
Channels` (ambient / public / private / operator; the influence ladder tops
out at nudge) · `Boundaries` (what is refused: metric space, populations,
general-purpose expressions) · `Package Layout` (schema, kernel, runtime,
view modules).
Status line: describes shipped kernel behavior; deferred modules (space,
lockstep) named as designed-deferred with one line each.

**`reference/ledger-and-telemetry.md`** (NEW)
Purpose: the world-model data contract: what gets recorded, how, and where.
Sections: `Ledger vs Telemetry` (acts vs motion; nothing stored that can be
recomputed) · `Event Shape` (`event_id`, `kind`, `sim_time`, `provenance`,
`actor`, `target`, `scope`, `payload`) · `Event Kinds` (the frozen v1 table:
`world.message`, `world.dm`, `wake.recommended`, `rule.fired`, `marker.seen`,
`clock.sync`; reserved kinds listed as reserved) · `Scope Grammar` (Mneme
form; the provider-prefix seam noted honestly) · `Canonical Export`
(sorted-key JSONL, stripped non-identity fields, byte-identity asserted here)
· `Stores` (`jsonl` implemented; `sqlite`/`postgres` statused against the
shipped code, badge `planned` if not landed) · `Telemetry Snapshots`
(`snapshot_every`, re-derivation) · `The Run Record` (directory layout,
manifest fields, exports).
Status line: run records as written by `simfile run` today; store kinds
beyond what ships are badged.

**`reference/probes-and-markers.md`** (NEW)
Purpose: the normative reference for the verdict layer (the guide teaches;
this page specifies).
Sections: `Probe Anatomy` (`when` + `expect` + `after`/`within`; per-tick vs
per-occurrence matching) · `Expect Primitives` (`at_least`, `at_most`,
`always`, `at_end`) · `Marker Anatomy` (`text` aliases, case-insensitive
exact matching, `mode`, `scopes`) · `Compiled Probes` (containment →
planted + contained; propagation → reached) · `Evaluation Modes` (post-run
implemented; streaming `--follow` planned, identical-semantics promise
stated as design intent) · `Verdicts and Evidence` (report shape, event-id
evidence) · `The Claim Boundary` (literal leakage only).
Status line: post-run evaluation inside `simfile run` reports is the
implemented surface; standalone `simfile probes` is planned.

**`reference/viewer.md`** (NEW)
Purpose: the read-only contract that lets a third party build on viewer data.
Sections: `Serving Model` (static app served by the CLI; live vs replay
inputs) · `HTTP Endpoints` (`GET /api/state`, `GET /api/skins`,
`GET /api/events`, with response shapes as shipped) · `Read-Only Guarantee`
(single-writer rule; the viewer never writes; future write proxies are
tier-gated and badged `planned`) · `The Run-Record Contract` (what a
third-party viewer may rely on: manifest, canonical ledger, telemetry,
viewer-trace) · `Deep Links` (badge per implementation status) · `Future
Surface` (`--moltnet` proxy, `--skin`, badged `planned`).
Status line: endpoints documented from the shipped server code, not from
VIEW_DESIGN aspiration; anything not in `src/view/server.ts` is badged.

### Cross-cutting content rules

- Titles and sidebar labels in Title Case, matching Moltnet's sidebar tone.
- Every page has a `description:` in frontmatter (feeds SEO and llms.txt).
- Examples use only fixtures that exist in `fixtures/`; schema examples must
  pass `simfile validate` (wire this as a docs CI check, the site's version of
  the honest-status rule).
- Diagrams are mermaid under the shared styling; at most one violet-stroked
  node per diagram.
- Pages stay short and factual (the website guide's standing rule); depth
  comes from the reference pages, not from long guides.
- No page restates live-mode maturity in its own words: link to
  `guides/live-vs-replay.md`.
