# Simfile

> Deterministic simulation worlds for societies of agents — seed an idea, run the world, and watch it move through minds.

<p align="center">
  <a href="https://www.npmjs.com/package/simfile"><img src="https://img.shields.io/npm/v/simfile?style=flat-square&color=7c5cff&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/simfile"><img src="https://img.shields.io/npm/dm/simfile?style=flat-square&color=7c5cff" alt="downloads"></a>
  <a href="#source-clone-quick-start"><img src="https://img.shields.io/node/v/simfile?style=flat-square&color=7c5cff" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/simfile?style=flat-square&color=7c5cff" alt="MIT"></a>
  <a href="https://simfile.org"><img src="https://img.shields.io/website?url=https%3A%2F%2Fsimfile.org&style=flat-square&label=simfile.org&color=7c5cff" alt="website"></a>
</p>

Spawnfile declares *who* runs and how an organization is wired — agents, teams, rooms, runtimes, memory. **Simfile declares the *world* around them** — a clock, variables, generators, rules, markers, probes, and a run ledger — then runs it and lets you watch.

Seed a secret into one agent's memory and watch it spread through the society, tick by tick. Open an agent that is *itself* an organization — a Jungian self whose Shadow and Anima deliberate in an inner room — and descend into it. Every message, wake, turn, memory write, and variable change is a ledger event, so the viewer scrubs the whole run backward and forward and every glyph on screen traces to a record.

Deterministic and replayable. Observer-tier by design: Simfile authors and observes worlds — it compiles no Docker images and deploys no agents. That is [**Spawnfile**](https://spawnfile.com)'s job (the organization that runs *in* the world), talking over [**Moltnet**](https://moltnet.dev) (the rooms the agents share).

## Contents

- [Source-clone quick start](#source-clone-quick-start)
- [Develop with Spawnfile](#develop-with-spawnfile)
- [Installed package](#installed-package)
- [What you can see](#what-you-can-see)
- [The world](#the-world)
- [Example](#example)
- [Observe](#observe)
- [Repo guide](#repo-guide)
- [Docs](#docs)

## Source-clone quick start

This is the current working path for a new contributor. It runs Simfile's
checked-in deterministic mechanics example locally; it needs **no Spawnfile,
Docker, GPU, credentials, or sibling checkout**.

```bash
git clone https://github.com/noopolis/simfile.git
cd simfile
npm ci
npm run build
npm run example:local
```

The command runs the dream mechanics from the canonical
`examples/jungian-dialogue/Simfile` in bounded local mode and prints its
unique `runs/example-local-...` directory. Local mode does not start the two
agents; use the composed path below to see their conversation.
Use `node dist/cli/index.js view <printed-run-directory>` to inspect it. These
source-clone commands invoke the checkout's freshly built CLI directly, with
no registry or global command resolution. Node.js >=22.19.0 is required.

## Develop with Spawnfile

Spawnfile is a separate product and repository. A Simfile contributor can
install any Spawnfile checkout into an isolated, ignored tool root; the two
repositories do not need to be siblings and Simfile never imports Spawnfile
source.

Install a Spawnfile source checkout or an exact published package into an
isolated tool root. If using a checkout, its absolute path is explicit:

```bash
git clone https://github.com/noopolis/simfile.git
git clone https://github.com/noopolis/spawnfile.git /absolute/path/to/spawnfile

cd simfile
npm ci
npm run build
npm run dev:spawnfile:setup -- --source /absolute/path/to/spawnfile
npm run dev:spawnfile:check
```

Setup copies that exact Spawnfile checkout into a private temporary stage,
runs `npm ci`, builds and packs only the staged copy, then installs the tarball
under `.simfile-dev/spawnfile/`. It does not mutate the source checkout or use
a global CLI, `../spawnfile`, or a `file:` dependency. The check validates
`examples/jungian-dialogue/org/Spawnfile` through the isolated
parser/compiler front end and records Simfile's own
`simfile.spawnfile-public-capability-probe.v1`.

The probe uses only generic documented Spawnfile CLI surfaces: `--version`,
`capabilities --json` when the installed release supports it, and legacy
command `--help` only as a fail-closed fallback. It never calls `spawnfile
compatibility --profile simfile.*` or asks Spawnfile to recognize
Simfile-specific profiles. Missing capabilities are explicit blockers, never
machine defaults or private helpers.

For a published release, use `npm run dev:spawnfile:setup -- --package
spawnfile@<exact-version>` instead. `npm run
dev:spawnfile:status` shows the isolated executable and its last probe result.
For a prepacked release artifact, avoid registry resolution entirely with
`npm run dev:spawnfile:setup -- --artifact /absolute/release.tgz --sha256
<lowercase-sha256>`; setup verifies and records that physical artifact origin.

The bounded lifecycle/replay example is a credential-free Jungian dialogue:

```bash
npm run example:composed -- --context <local-docker-context>
```

Run it only after `dev:spawnfile:check` reports the composed portion of
`simfile.spawnfile-public-capability-probe.v1` as ready. The admitted contract
is the exact Spawnfile 0.1.17 public 43-command set. Before Simfile opens
support state or invokes a target mutation, the runner pins the isolated
executable and proves that the explicitly selected context resolves to a local
Unix-socket, named-pipe, or file-descriptor endpoint. Older or drifted
contracts fail closed.

The analyst observes a black door, tarnished mirror, and lost child through a
bearer-authenticated world sense, then a scripted five-message mention chain
runs through the Spawnfile-managed Moltnet room. The words are an authored
screenplay, clearly labeled as such; the exported room messages are genuine
engine outputs from the run. The invocation pins `--mode
lifecycle-replay-smoke` and a unique run ID/output. Its versioned receipt
proves lifecycle completion and exact replay and reports live agent-action
evidence as `not_evaluated`. The former one-agent lifecycle regression remains
available only as `npm run example:internal-smoke -- --context <context>`.
Omitting `--mode` from an ordinary linked run
retains the strict live verdict, including the requirement for an authenticated
applied action from every principal.

## Installed package

For a project-installed package, start with `npm exec -- simfile --help`; for a global install, use `simfile --help`. Then
use the commands that match the installed release's documentation. The
source-clone command above intentionally uses the checkout's freshly built CLI
and checked-in example.

## Commands

```bash
simfile validate ./Simfile.yaml     # check a world
simfile run ./Simfile --local --ticks 200  # bounded mechanics-only diagnostic
simfile view runs/<id>              # replay a sealed run — scrub, descend, watch spread
simfile view --state .sim           # watch a live world
simfile observe runs/<id>           # reconcile causal chains + measure spread → report.json
```

Linked composition is not the source-clone quick start. Run the standalone
setup and public capability probe first. A linked project may use `simfile run`
only when the composed probe is ready; it performs
lifecycle composition by starting
the world paused on `simfile.world-sidecar-runtime.v1`, delegates organization
lifecycle to Spawnfile's public CLI, attests the topology and any separately
manifested capability extensions, and atomically activates both owners. Tick 1
and every later tick have no agent barrier. Organization-declared schedules
wake autonomous runtimes; Simfile never selects, wakes, invokes, polls, or
waits for cognition. Observation recommendations are optional pull-only sense
metadata, never deliveries or wake authority.

The live receipt also binds Spawnfile's pinned
`spawnfile.moltnet-release-identity.v1`: architecture, asset digest, release
version, source revision, and the exact `pi-bridge` capability. Unpinned
`latest` is not a live input.

## What you can see

`simfile view <run-dir>` serves a local web app that turns a run into an instrument, not a screensaver:

- **Scrub the whole run.** One causally-ordered timeline — play, rewind, step. The world map, the room chat, and every agent's memory all move together off a single cursor. A sealed run with participant speech opens on Conversation; Map is the deterministic fallback, and either choice is deep-linkable.
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
| **rules** | `when` conditions → mechanical effects or observation metadata |
| **markers** | scan room traffic for tokens (a seeded secret, a name) |
| **probes** | scored assertions evaluated over a run |
| **run ledger** | the canonical, causally-ordered record everything else is measured against |

Domain concepts live in fixtures, never in schema keys.

## Example

The canonical composed project is [`examples/jungian-dialogue`](examples/jungian-dialogue/README.md):

```yaml
simfile_version: "0.1"
name: jungian-dialogue
spawnfile: ./org/Spawnfile

clock:
  seed: jungian-dialogue-seed
  tick: 1s
  sim_per_tick: 1s

dynamics:
  module: ./world/provider.mjs
  config:
    black_door: 1
    tarnished_mirror: 0.9
    lost_child: 0.8
    dread: 0.72

world:
  id: dream-consulting-room
  grants:
    analyst: { entity: entity:analyst, senses: [sense:dream], affordances: [] }
    daimon: { entity: entity:daimon, senses: [sense:dream], affordances: [] }

world_sidecar:
  binding: ./binding.mjs
  composer: ./world/composer.mjs
```

The linked Spawnfile declares the analyst and daimon in one consulting room;
the example README explains the story, evidence boundary, and exact commands.

## Observe

`simfile observe <run-dir>` reconciles every authority's causal stream — Moltnet, Daimon, Mneme, and the world kernel — into one honest verdict: complete vs. incomplete causal chains, per-agent memory, failures, and, for a seeded world, spread measurement (channel · reach · latency · fidelity) re-derived from sealed artifacts. Ordering is causal, never wall-clock; a missing link is reported, never stitched.

## Repo guide

```text
src/schema      v0.1 world schema + validator
src/runtime     deterministic world kernel (clock, generators, rules, markers, probes)
src/observe     causal reconciliation + spread measurement
src/view + web  the run-replay viewer (React), served by `simfile view`
scripts/        bounded contributor tooling, including isolated Spawnfile setup
docs/           design + research (DESIGN, VIEW_DESIGN, VIEW_STYLEGUIDE, …)
```

Simfile hardcodes constraints, not conclusions: it defines stable mechanics and observability, and leaves interpretation, strategy, dialogue, memory choice, and culture to the agents.

## Docs

Full documentation at [**simfile.org**](https://simfile.org). Design and research notes live in [`docs/`](docs/).

## License

MIT
