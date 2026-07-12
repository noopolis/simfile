---
title: CLI
description: Exact commands and flags implemented by the Simfile v0.1 CLI.
---

The current command set is `validate`, `run`, `observe`, and `view`.

```text
simfile validate <path> [--json] [--spawnfile-report <path>|<json>]
simfile run <path> --ticks <n> [--out <dir>] [--seed <seed>]
  [--run-id <id>] [--acts <path>]
  [--moltnet-artifact transcript|delivery]
  [--spawnfile-report <path>|<json>]
simfile observe <run-dir> [--json]
simfile view --state <path>
simfile view <run-record-dir>
simfile view --help
simfile --help
```

There is no public `compose`, `experiment`, `skin`, `probes`, or `report` command.

## `validate`

```bash
simfile validate ./Simfile
simfile validate ./Simfile --json
simfile validate ./Simfile --spawnfile-report .spawn/spawnfile-report.json
```

The path is required. Files whose path ends in `.json` are parsed as JSON; other paths are parsed as YAML.

Validation performs strict structural checks and semantic checks such as declared phase and variable references, expression dependencies, and fed-variable writer ownership. `--spawnfile-report` accepts either a file path or inline JSON and adds binding checks for referenced Spawnfile agents, teams, and rooms.

`--json` prints:

```json
{
  "diagnostics": [],
  "ok": true,
  "path": "./Simfile"
}
```

Unknown flags, extra positional arguments, parse failures, or error-level binding diagnostics return exit status `1`.

## `run`

```bash
simfile run ./Simfile --ticks 144
simfile run ./Simfile --ticks 144 --run-id office-014 --out runs/office-014
simfile run ./Simfile --ticks 144 --seed alternate-seed
```

`--ticks` is required and must be an integer greater than or equal to zero. The command validates first, then executes a bounded deterministic kernel trace without sleeping.

### Run flags

| Flag | Required | Meaning |
| --- | --- | --- |
| `--ticks <n>` | yes | Number of kernel ticks. |
| `--out <dir>` | no | Output directory; defaults to `runs/<run-id>`. |
| `--seed <seed>` | no | Effective seed; defaults to `clock.seed`. |
| `--run-id <id>` | no | Run ID; defaults to a filesystem-safe form of the effective seed. |
| `--acts <path>` | no | JSON array of queued `variable:set` world acts. |
| `--moltnet-artifact <kind>` | no | Add a harness-derived `transcript` or `delivery` artifact. |
| `--spawnfile-report <value>` | no | Add Spawnfile binding validation from a path or inline JSON. |

Every value flag also accepts `--flag=value`.

The output directory contains:

```text
manifest.yaml
ledger.jsonl
report.json
telemetry.json
viewer-trace.json
moltnet-transcript.json   optional
moltnet-delivery.json     optional
```

The optional Moltnet files are explicitly marked `harness-derived`; they are not evidence captured from a live Moltnet service. Failed marker or probe evaluations are recorded in `report.json` but do not make the command itself fail.

`simfile run` does not start the file referenced by top-level `spawnfile:`. Passing `--spawnfile-report` validates bindings only. Agent-backed composition currently uses source drivers under `src/sims/`; see [Spawnfile integration](/guides/spawnfile-integration/).

### Queued world acts

`--acts` must point to a JSON array. The accepted act shape is:

```json
[
  {
    "at_tick": 3,
    "act_id": "referee-set-1",
    "action": "variable:set",
    "variable": "adjudicated_signal",
    "value": 0.75,
    "actor": "referee",
    "principal_id": "agent:referee",
    "cause_event_ids": ["external:event-1"]
  }
]
```

`at_tick` must be a non-negative integer within the run. `act_id` is non-empty and at most 128 characters. The target variable must declare the same actor under `fed_by`; out-of-range, non-finite, duplicate, unauthorized, late, and unknown-variable acts are rejected and reported in the kernel `report.json`.

## `observe`

```bash
simfile observe runs/<run-id>
simfile observe runs/<run-id> --json
```

`observe` expects a composed and sealed `simfile.run-manifest.v1` directory with root `manifest.json` and exported causal artifacts. It does not consume the `manifest.yaml` directory produced by the finite kernel command.

The command verifies manifest SHA-256 entries, parses `raw/**/causal.jsonl`, reconciles causal records, derives memory counts, and optionally derives seed spread. It writes:

```text
runs/<run-id>/observe/report.json
```

This is distinct from the kernel run's root `report.json`.

`--json` prints `artifactIntegrity`, `causalParseErrors`, the complete `report`, and `reportPath`. Artifact mismatches are warnings and produce exit status `1`. Causal JSONL parse errors are warnings but do not alone change the exit status. Incomplete causal chains and reported failures are measurements; they do not by themselves change the CLI exit status.

See [Observe](/guides/observe/) for the report and reconciliation contract.

## `view`

```bash
simfile view runs/<run-id>
simfile view --state .sim
simfile view runs/<run-id> --port 4400 --no-open
simfile view --help
```

### View flags

| Flag | Meaning |
| --- | --- |
| `--state <path>` | Select the snapshot-style live console over a state directory. |
| `--port <n>` | Local server port from 1024 through 65535; default `4400`. |
| `--no-open` | Do not launch the browser automatically. |
| `--help`, `-h` | Print view usage. |

With a positional directory, the server selects replay behavior from the directory shape:

- `manifest.json` at `simfile.run-manifest.v1` plus a Moltnet transcript opens the full run-replay application;
- `manifest.yaml` plus `viewer-trace.json` opens the world replay console.

`--state` opens the live-labeled console over `viewer-trace.json`. That current surface reads a snapshot and serves a synthetic looping tick heartbeat; it is not yet a live tail of ledger or Moltnet events.

The server runs until interrupted. Read [Viewer](/guides/viewer/) for the exact mode and artifact behavior.

## Help and exit behavior

`simfile --help` and `simfile -h` return success. Running `simfile` with no command prints usage and returns exit status `1`. Individual `validate`, `run`, and `observe` commands do not implement their own `--help`; `simfile view --help` does.
