---
title: Observe a Run
description: Reconcile sealed causal artifacts and re-derive memory and seed-spread measurements.
---

`observe` turns a sealed run directory into an independently derived report. It reads the artifacts left by the world, Moltnet, Daimon, and Mneme; verifies the bytes declared by the manifest; reconciles their causal references; and writes one machine-readable result.

```bash
simfile observe runs/<id>
```

The report is written to:

```text
runs/<id>/observe/report.json
```

Use `--json` when another program needs the report together with artifact-integrity checks and causal parse diagnostics:

```bash
simfile observe runs/<id> --json
```

## What counts as a sealed run

At minimum, the run directory has a `manifest.json` conforming to `simfile.run-manifest.v1`. Its `artifacts` array names the files that belong to the run and records the expected SHA-256 digest of each one.

A composed run normally includes this shape:

```text
runs/<id>/
├── manifest.json
├── raw/
│   ├── daimon/<agent>/causal.jsonl
│   ├── mneme/<bank>/causal.jsonl
│   ├── mneme/<bank>/events.jsonl
│   ├── moltnet/**/causal.jsonl
│   ├── moltnet/**/transcript.json
│   └── world/causal.jsonl
└── world/
    └── ingested-messages.jsonl
```

Not every run needs every optional artifact. A run without `seed_declaration`, for example, does not need the transcript and world-tick joins used to measure spread. `observe` discovers every `raw/**/causal.jsonl` stream recursively rather than assuming one fixed organization layout.

## Integrity before interpretation

For every file declared in `manifest.json`, `observe` computes its SHA-256 digest and compares it with the manifest. A missing file or mismatched digest is reported as a failed integrity check. The tool does not repair the artifact, substitute another file, or hide the mismatch.

The report is still written so the evidence can be inspected, but the command exits with status `1` when any declared artifact fails verification. Malformed causal JSONL lines are emitted as warnings and included in `causalParseErrors` under `--json`; parse warnings alone do not change the exit status. An invalid manifest, unsupported spread matcher, or other fatal read or validation error also exits with status `1`.

## Causal reconciliation

`observe` reconciles the collected causal events by `event_id`, stream identity and sequence, cross-store fact hashes, and explicit `cause_event_ids`. It never orders a chain by `recorded_at`, guesses from proximity, or invents an edge to make a trace look complete.

The report records:

- `chains.complete`: the number of event records whose declared causal references reconcile cleanly.
- `chains.incomplete`: event records that could not be accepted as complete, each with its `event_id` and a flag.

The possible flags are:

- `divergent`: conflicting duplicates, conflicting occupants of one stream sequence slot, or a conflicting cross-store content hash.
- `unknown`: a cause names an authority from which the run contains no events.
- `partial`: a cause names an event that is absent even though that authority is present.
- `stale`: the report schema reserves this for a stream known to lag a declared final sequence. Current `observe` does not pass final-sequence declarations, so it cannot emit this state today.

These counts describe reconciled event records. They are not a claim that an absent event was reconstructed. A missing link is reported, never stitched.

`agent_turns.sequence` is also causal: completed Daimon turns are ordered by the Moltnet message sequence that triggered their input, never by wall-clock timestamps.

## Memory accounting

Each entry in `memory` describes one Mneme bank:

- `events` is the memory-write count.
- `recalls` is the recall count.
- `memory_write_source` discloses where the write count came from.
- `writes_by_agent`, when available, attributes ledger writes to agents.

The observer is ledger-first. If a bank contains any causal `memory.written` events, those events are authoritative, `memory_write_source` is `ledger`, and `writes_by_agent` is derived from their principals.

Older runs may predate that write-side causal event. For those runs, the observer counts the bank's non-empty `events.jsonl` rows as the write proxy and marks the result `events-fallback`. Recall counts prefer explicit `memory.recalled` rows in the same bank log, falling back to causal recall events only when the log is absent. The fallback is disclosed rather than silently treated as ledger evidence.

## Seed-spread measurement

When `manifest.json` contains `seed_declaration`, `observe` re-derives `seed_spread` from the sealed artifacts. It does not trust the live world's `marker.seen` verdict as measurement evidence. That live marker is used only for a diagnostic self-check.

The channels are:

- `doc-seeded`: the single declared entry in the seed agent's document, taken from the manifest.
- `uttered`: a matching agent-authored Moltnet transcript message.
- `registered`: matching content recorded in a Mneme bank, joined to `memory.written` when that ledger event exists.
- `recalled`: a causal `memory.recalled` event whose joined bank content matches.

The observer deliberately does not scan `turn.input.submitted` payloads. A token in an agent's prompt proves exposure, not expression. Hits authored by `world` or `operator:<agent>` are also excluded from spread and reported in `failures` as instrument or containment errors.

Every spread entry identifies its `channel` and `event_id`, and may include `agent`, `tick`, `fidelity`, and `memory_write_source`. Exact matches have fidelity `1`. The `tick` is joined from `world/ingested-messages.jsonl` or traced backward through real causal edges to the Moltnet message that produced a memory event; it is never fabricated.

The manifest pins the matcher policy. `exact` uses case-insensitive Unicode word boundaries. `edit-distance` defaults to distance 2 and also accepts a bound such as `edit-distance:1`; its fidelity is normalized Levenshtein closeness. Embedding and judge policies are recognized but fail loudly in this runtime-neutral build because no model is available to execute them.

`spread_summary` contains:

- `reach`: distinct non-seed agents with at least one measured appearance.
- `latency`: the lowest known absolute world tick among those agents' first appearances. It does not subtract a seed tick and is omitted when no appearance can be joined to a tick.
- `first_appearance`: one earliest known entry per reached agent.

The serialized `seed_spread` array is grouped by channel derivation: seed, utterances, registrations, then recalls. Treat event ids and ticks as its evidence; do not assume array position is a global causal order.

See [Memetics Experiment](/guides/memetics/) for the seeded, replacement, and unseeded experimental design.

## Report shape

`observe/report.json` conforms to `simfile.observe.v1`:

| Field | Meaning |
|---|---|
| `version` | Report contract, currently `simfile.observe.v1`. |
| `run_id` | The run named by the manifest. |
| `contract_versions` | Versions of the contracts used by the run. |
| `participants` | Sorted agent principals found in causal events. |
| `agent_turns` | Completed-turn count and causal sequence. |
| `chains` | Complete event-record count and flagged incomplete records. |
| `memory` | Per-bank writes, recalls, and provenance. |
| `failures` | Causal turn/wake failures and excluded instrument spread hits. |
| `seed_spread` | Optional channel-level appearances for a seed-declared run. |
| `spread_summary` | Optional reach, first appearance, and tick latency. |
| `wake_diff` | Reserved optional expected-wake comparison; current observation does not populate it. |

## A concrete sealed result

The committed `fixtures/observe/office-secret-v0-golden/` run is small enough to audit by hand. Its report contains:

- participants `eleanor` and `sam`;
- 3 completed turns in the sequence `eleanor → sam → eleanor`;
- 24 complete event records and 0 incomplete records;
- 10 memory-event rows, 2 recalls, and `events-fallback` provenance for `office-recall`;
- 0 failures;
- 9 spread entries: 1 `doc-seeded`, 2 `uttered`, 5 `registered`, and 1 `recalled`;
- fidelity `1` for every spread entry;
- reach `1`, with Sam's first appearance as an `uttered` event at tick `1`.

That fixture was captured through the real composed Spawnfile and Moltnet path, but its manifest says `engine: scripted`. It proves artifact sealing, reconciliation, and measurement; it is not evidence of emergent dialogue from a model. The real-engine experiments are identified separately by the viewer's engine-provenance badge and in the memetics guide.
