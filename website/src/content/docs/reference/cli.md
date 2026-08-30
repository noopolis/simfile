---
title: CLI
description: Exact commands and flags implemented by the Simfile v0.1 CLI.
---

The current command set is `validate`, `run`, `observe`, `view`, and `recover`.

```text
simfile validate <path> [--json] [--spawnfile-report <path>|<json>]
simfile run <path> [--view] [--out <dir>] [--seed <seed>] [--run-id <id>]
simfile run <path> --local --ticks <n> [--out <dir>] [--seed <seed>]
  [--run-id <id>] [--acts <path>] [--clock <iso>]
  [--moltnet-artifact transcript|delivery]
  [--spawnfile-report <path>|<json>]
simfile observe <run-dir> [--json]
simfile view --state <path>
simfile view <run-record-dir>
simfile view --help
simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>
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

## `recover`

```bash
simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>
```

`--journal` must be the normalized absolute path to the exact journal file in
the composed run's support directory (normally
`<support-root>/journal/phase-journal.json`); it does not accept the support
directory itself. `--run-id` must match the journal's run ID, and
`--authority-digest` must be a `sha256:` digest that matches its authority.
These are the only options, in this exact order; there is no `--json` flag.

Version-2 journals carry a secret-free bootstrap capsule that pins the exact
Spawnfile executable, capability contract, local context, paths, and public
project identities. Recovery reconstructs the resolver-backed provider from
that capsule, reconciles typed target and lifecycle lookups, and resumes only
after exact identity verification. An unresolved credential-provisioning
intent is reported as ambiguous and is never retried automatically. Legacy
journals without the capsule fail closed. Invalid syntax, an
unavailable or unsafe journal, and an authority mismatch also return `1` and
write the error to standard error.

## `run`

```bash
simfile run ./Simfile --local --ticks 144
simfile run ./Simfile --local --ticks 144 --run-id office-014 --out runs/office-014
simfile run ./Simfile --local --ticks 144 --seed alternate-seed
simfile run ./Simfile --mode lifecycle-replay-smoke --out runs/composed-smoke
```

`--local --ticks` executes a bounded deterministic kernel trace without
sleeping. Linked `simfile run <linked Simfile>` accepts neither `--ticks` nor
`--spawnfile-report`, and requires a project binding plus a Spawnfile CLI whose
generic public surfaces satisfy Simfile's
`simfile.spawnfile-public-capability-probe.v1`. For source development, install
and check that CLI with `npm run dev:spawnfile:setup` and `npm run
dev:spawnfile:check`; see [Spawnfile integration](/guides/spawnfile-integration/).
The source-checkout aliases are `npm run example:local` and `npm run
example:composed -- --context <local-docker-context>`.

### Run flags

| Flag | Required | Meaning |
| --- | --- | --- |
| `--ticks <n>` | local only | Number of kernel ticks. |
| `--mode <mode>` | linked only | `live` (default) or the distinct `lifecycle-replay-smoke` evaluation. |
| `--out <dir>` | no | Output directory; defaults to `runs/<run-id>`. |
| `--seed <seed>` | no | Effective seed; defaults to `clock.seed`. |
| `--run-id <id>` | no | Run ID; defaults to a filesystem-safe form of the effective seed. |
| `--acts <path>` | local only | JSON array of queued `variable:set` world acts. |
| `--clock <iso>` | local only | Deterministic override for the wall-clock instant used to create the run record. |
| `--moltnet-artifact <kind>` | local only | Add a harness-derived `transcript` or `delivery` artifact. |
| `--spawnfile-report <value>` | local only | Add Spawnfile binding validation from a path or inline JSON. |

Every value flag also accepts `--flag=value`.

When the external lifecycle completes, `lifecycle-replay-smoke`
emits `simfile.composed-lifecycle-replay-smoke-receipt.v1`. It proves a
completed lifecycle and exact replay while declaring live agent-action
evidence `not_evaluated`; it never produces the strict live simulation
verdict. The development runner admits the exact Spawnfile 0.1.17 public
contract and proves the selected endpoint is local before starting the run.

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

Local mode only uses `--spawnfile-report` for binding validation. Linked
composition starts the declared project through Spawnfile's public CLI only
after Simfile's public capability probe succeeds. See
[Spawnfile integration](/guides/spawnfile-integration/).

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

- `manifest.json` at `simfile.run-manifest.v1` opens the full run-replay application; Moltnet transcripts are optional inputs;
- `manifest.yaml` plus `viewer-trace.json` opens the world replay console.

`--state` opens the live-labeled console over `viewer-trace.json`. That current surface reads a snapshot and serves a synthetic looping tick heartbeat; it is not yet a live tail of ledger or Moltnet events.

The server runs until interrupted. Read [Viewer](/guides/viewer/) for the exact mode and artifact behavior.

## Help and exit behavior

`simfile --help` and `simfile -h` return success. Running `simfile` with no command prints usage and returns exit status `1`. The usage overview includes `recover` and its required arguments. Individual `validate`, `run`, `observe`, and `recover` commands do not implement their own `--help`; `simfile view --help` does.
