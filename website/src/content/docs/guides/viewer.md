---
title: Run-Replay Viewer
description: Scrub sealed agent runs, inspect causal storylines, descend through membranes, and trace every measurement to artifacts.
---

The Simfile viewer is a local observer interface for a world trace or a sealed compose-and-observe run. Its most complete mode is **run-replay**: one cursor drives the room conversation, memory, causal storylines, variables, and seeded-meme evidence together.

```bash
simfile observe runs/<run-id>
simfile view runs/<run-id>
```

The viewer binds to `127.0.0.1`, opens a browser by default, and uses port `4400` unless you choose another valid port.

```bash
simfile view runs/<run-id> --port 4400 --no-open
simfile view --state .sim/
```

## Three viewer modes

| Mode | How it is selected | What it shows |
|---|---|---|
| Run-replay | `simfile view <dir>` where `<dir>` contains a `simfile.run-manifest.v1` `manifest.json` | The full scrub timeline, with optional chat/memory surfaces only when their artifacts exist |
| Trace replay | `simfile view <dir>` for another run-record shape | The world console over a sealed `manifest.yaml` plus `viewer-trace.json` |
| Live | `simfile view --state <dir>` | The world console over `<dir>/viewer-trace.json` with its current heartbeat/tick display |

Run-replay is selected from the manifest shape, not by a flag. A transcript is
optional; when present it may be `raw/moltnet/transcript.json` or
`raw/moltnet/<network-id>/transcript.json`.

The current live surface is deliberately modest: it loads `viewer-trace.json` and runs a local heartbeat that loops through the trace's tick range. It does not yet tail a changing ledger or connect to Moltnet's live event stream. Use run-replay when you need the research instrument described below.

## What run-replay reads

Run-replay rebuilds its view from the sealed run directory. It does not trust a previously written `observe/report.json` as its source of truth; it runs the same observation and reconciliation pipeline again in memory.

Its inputs are:

- `manifest.json`, including the declared artifacts and optional `seed_declaration`;
- every `raw/**/causal.jsonl` stream;
- optional Moltnet transcript or transcripts;
- optional `raw/mneme/<bank>/events.jsonl` memory logs;
- optional `spawnfile-report.json` for nested team membranes;
- optional `world/telemetry.json` for variable samples;
- optional `world/ingested-messages.jsonl` for message-to-world-tick joins;
- optional `spawnfile/up-receipt.json` for per-agent engine provenance.

Every artifact declared by the manifest is checked against its recorded SHA-256. Missing optional inputs remove the corresponding surface or leave its provenance explicitly unknown; the viewer does not fabricate empty measurements, variables, memories, or membranes.

## One timeline

The scrubber uses one dense event cursor across the entire run. Records are first ordered deterministically by recorded time and stream identity, then causally repaired so a known cause cannot appear after its effect. A missing cause remains missing; replay never invents a link to make the sequence look complete.

The global controls provide start, end, single-step, play or pause, and `0.5x`, `1x`, `2x`, `4x`, or `8x` playback. Playback is disabled when the browser requests reduced motion. When the run contains real `clock.sync` records, the scrubber also shows world ticks and phase bands. Seed-spread events appear as cyan dots only when their report event IDs join to actual timeline records.

## Primary views and minds

Conversation and Map are selectable primary views. On the first load of a
sealed run, Conversation is selected only when the complete timeline contains
a nonblank message from a declared participant—the exact projection the chat
will show. World/control messages, undeclared actors, and blank records do not
trigger it. Map is the deterministic fallback. An explicit deep link or an
existing user choice wins and is not reset when the cursor moves or a live run
seals.

### World map

The map renders rooms, participants, signals, and derived presentation geometry from the `viewer.trace.v1` contract. Compose-and-observe runs without a place-bearing world show an informational room anchor and explicitly label participant placement as heuristic. Do not read those positions as recorded movement.

In those runs the map's principal cursor-driven change is meme-spread highlighting. Physical movement replay requires presence records; the viewer does not synthesize them.

### Room chat

Chat shows messages at or before the cursor. A world action delivered through Moltnet renders once, on its Moltnet echo, with a `world` badge. A world message with no recorded echo remains visible as `not delivered`.

Messages expose their immediate causal children as clickable chips. A `turn.input` whose causes include a real `mneme:` recall gets a recall chip that jumps to and highlights the exact `memory.recalled` record. Mentions, delivery state, seeded utterances, and membrane-boundary speech are all visibly marked.

### Minds

The minds rail groups `memory.claimed`, `memory.observed`, and `memory.recalled` records by bank and agent as of the cursor. It shows the latest six strata in the compact rail. Select a bank or agent to open the full storyline.

## Per-element storylines

Agents, rooms, memory banks, teams, and variables use one portal mechanism. Open one by selecting a map node, chat author, mind, bank, or variable gauge. Several portals can remain open at once; closing one does not reset the others or the map selection.

A flat storyline contains every timeline event whose `subjects` include that element. Past, current, and future rows remain visible around a moving now-line, and selecting a row moves the global cursor. Recall chips use shared event-ID highlighting, so a memory selected from chat lights up the same record in an open agent or bank portal.

When `world/telemetry.json` contains real variable samples, the header shows the value as of the current world tick and its recorded trajectory. Selecting a variable opens its sample history alongside the rule and world-effect events that name `variable:<id>`. Before the first `clock.sync`, or without samples, no gauge is shown.

## Descend into a mind

A mind membrane is not inferred for every agent. It appears only when `spawnfile-report.json` describes a team with its own Moltnet interior and an agent representing that team on a parent floor.

For each such membrane, the outer map adds a `team:<id>` node beside its representative. Both receive a `⤵` affordance. Selecting the team enters the membrane directly; the representative's ordinary storyline instead offers a **descend into** button.

The membrane portal has two views:

- **Interior** repeats the same instrument at the next depth: an interior-room map, chat restricted to those rooms, and minds restricted to the team's members and banks.
- **Crossings** shows the representative's storyline where the interior meets the parent world.

Both use the global cursor. Breadcrumbs preserve the path through the world, team, council room, and any descendant opened from there.

## Meme spread

When the manifest contains a `seed_declaration`, `observe` re-derives seed spread from the sealed transcript, causal streams, and memory artifacts. The viewer then projects those report records in four places:

- the header shows `spread <reach>/<eligible>` and the lowest known first-appearance world tick;
- cyan dots mark joined spread events on the scrubber;
- an `🧬 seed` badge marks messages classified on the `uttered` channel;
- the relevant agent and room glow after each non-seed agent's first-appearance event reaches the cursor.

The synthetic `doc-seed:<agent>:<epoch>` declaration has no timeline event, so it normally has no scrubber dot. Registered and recalled evidence can still produce dots when their event IDs join the timeline.

The current header also prints the first entry in `spread_summary.first_appearance`. That array is agent-sorted, so treat the label as a compact participant readout, not proof that the named agent was chronologically first. Per-entry channel and fidelity remain in `observe/report.json`; fidelity is not visualized in the current viewer.

## Engine and artifact provenance

Every valid run-replay exposes an engine-provenance badge before the verdict. Its state is one of `scripted`, `real-engine`, `mixed`, or `unknown`. Simfile prefers the per-agent engines in `spawnfile/up-receipt.json`, then falls back to `manifest.engine`; missing provenance stays unknown and is never presented as a real engine.

The verdict strip summarizes turns, complete and incomplete chains, memory events and recalls, failures, and verified artifacts. Open it to inspect each manifest artifact's SHA-256 status and the reconciliation summary. A scripted fixture is labeled as an authored screenplay so it cannot be mistaken for emergent dialogue.

## Deep links

Run-replay serializes the current event, selection, portal stack, and primary panel into the query string:

```text
?at=<event-id>&sel=<element-ref>&portals=<comma-separated-element-refs>&panel=<map-or-conversation>
```

For example:

```text
?at=event-2&sel=agent%3Aeleanor&portals=room%3Anet%3Aroom%2Cbank%3Aoffice-recall&panel=conversation
```

`at` is a stable event ID, not the dense cursor index. When a run is re-derived, the link resolves that ID to its current causal position. Stale event IDs are ignored instead of crashing the viewer; an invalid explicit panel fails closed to Map. The URL updates with `history.replaceState`, so scrubbing does not fill browser history.

The current link does not encode camera pose, lenses, operator tier, or run ID. A URL hash is preserved but has no viewer meaning.

## Pixel accountability

Pixel accountability means a visual claim should identify the record or public artifact that supports it:

- chat, minds, and storylines come from transcript, causal, and bank records;
- recall chips resolve real cause IDs;
- spread dots, badges, and glows join exact `seed_spread` event IDs;
- tick and phase chrome appears only from `clock.sync`;
- variable gauges appear only from telemetry samples;
- artifact status comes from manifest hashes checked against sealed bytes.

Layout terrain, skins, synthesized membrane nodes, and heuristic participant positions are presentation derived from those records, not new world facts. The shipped viewer does not yet provide a universal “click any pixel to inspect its source record” debugger. Pixel accountability is the rule behind each claim-bearing surface, not permission to treat decorative or heuristic pixels as measurements.
