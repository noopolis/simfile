---
title: Spawnfile Integration
description: How Simfile binds to, runs around, and observes a Spawnfile organization without absorbing it.
---

Spawnfile owns the organization. Simfile owns the deterministic world and the resulting measurement. Their integration is through versioned files, CLI receipts, and Moltnet, not imports of Spawnfile internals.

## Authoring reference versus resolved graph

A Simfile may point at the authored organization:

```yaml
spawnfile: ../org/Spawnfile
```

That string is a source reference for authors and orchestration. `simfile validate` and local `simfile run --local` do not start the organization; linked `simfile run <Simfile>` delegates lifecycle to Spawnfile.

For binding validation, pass Spawnfile's machine-readable resolved graph explicitly:

```bash
simfile validate ./world/Simfile \
  --spawnfile-report .spawn/spawnfile-report.json
```

The same check can run before a finite kernel trace:

```bash
simfile run ./world/Simfile --local \
  --ticks 144 \
  --out runs/world-check \
  --spawnfile-report .spawn/spawnfile-report.json
```

The report lets Simfile verify referenced agents, teams, and rooms in variable and marker scopes, rule and probe event filters, and rule action targets. Passing the report still does not turn that local run into an agent-backed composition.

## The production composition boundary

Linked `simfile run <Simfile>` is the composition entrypoint. It delegates
organization lifecycle to Spawnfile and advances world mechanics independently
of cognition. It requires a compatible Spawnfile CLI and a project-owned
binding; it is not the mechanics-only quick start.

### Standalone contributor setup

Clone Spawnfile wherever you keep source checkouts, then give Simfile its
absolute path:

```bash
cd /absolute/path/to/simfile
npm ci
npm run build
npm run dev:spawnfile:setup -- --source /absolute/path/to/spawnfile
npm run dev:spawnfile:check
```

Setup copies the selected Spawnfile checkout into a private temporary stage,
runs `npm ci`, builds and packs only that stage, and physically installs the
tarball beneath Simfile's ignored
`.simfile-dev/spawnfile/` root. The selected executable and Simfile's own
capability probe are recorded in `.simfile-dev/spawnfile/current.json`. There
is no `../spawnfile` convention, global link, or runtime import between
projects.

The check validates
`examples/jungian-dialogue/org/Spawnfile` through that exact CLI, then
records `simfile.spawnfile-public-capability-probe.v1`. The probe reads only
generic documented surfaces: `--version`, `capabilities --json` when
available, and command `--help` as an older-release fallback. It never calls
`spawnfile compatibility --profile simfile.*` or requires Spawnfile to ship
Simfile-specific profiles.

Do not proceed when the composed probe is not ready. Its missing or
unverifiable capabilities are product work, not values the operator should
guess. In particular, a target selector, base-image config digest, and private
helper command must not be copied from one developer's machine.

The checked-in Jungian dialogue has one explicit composed runner:

```bash
npm run example:composed -- --context <local-docker-context>
```

It runs only after the composed capability probe is ready. Simfile pins the
exact Spawnfile 0.1.17 43-command public contract and its executable identity.
The runner then calls the public target resolver to prove that the explicit
context is local before starting Simfile. Older, remote, default-selected, or
contract-drifted installations stop before lifecycle mutation.

The invocation pins `--mode lifecycle-replay-smoke` and a unique run/output.
The analyst and daimon exchange a finite authored screenplay through a real
Spawnfile-managed Moltnet room after the analyst claims and observes the dream
world with its generated bearer token. Its
`simfile.composed-lifecycle-replay-smoke-receipt.v1` proves lifecycle
completion and exact replay, but reports strategic live agent-action evidence
as `not_evaluated`; transcript messages remain genuine exported engine output.
The default live run and its action-evidence verdict are unchanged. The old
one-agent regression is explicitly internal:

```bash
npm run example:internal-smoke -- --context <local-docker-context>
```

Install a compatible release by exact coordinate:

```bash
npm run dev:spawnfile:setup -- --package spawnfile@<exact-version>
```

A prepacked release can be installed without registry resolution:

```bash
npm run dev:spawnfile:setup -- --artifact /absolute/release.tgz --sha256 <lowercase-sha256>
```

Lifecycle composition uses these documented Spawnfile command families:

```bash
spawnfile lifecycle lookup <invocation-id>
spawnfile up <org> --detach --deployment <name> --json --lifecycle-invocation <id> ...
spawnfile artifacts export <org> --out <directory> --json --lifecycle-invocation <id>
spawnfile down <org> --deployment <name> --json --lifecycle-invocation <id>
```

Between `up` and export, agents and the world communicate through declared
provider and action-ingress contracts. Export happens before teardown, and the
linked Simfile supervisor seals its manifest only after all declared artifacts exist.
There is no separate public `simfile compose` command.

## The artifact boundary

A composed run can contain:

```text
manifest.json                         simfile.run-manifest.v1 + SHA-256 entries
raw/moltnet/**/transcript.json        room messages
raw/moltnet/**/causal.jsonl           accepted-message causal events
raw/daimon/<agent>/causal.jsonl       wake and turn events
raw/mneme/<bank>/causal.jsonl         memory causal events
raw/mneme/<bank>/events.jsonl         bank content/fallback signal
raw/world/causal.jsonl                world clock, rules, and marker events
world/ingested-messages.jsonl         Moltnet message-to-world-tick join
world/telemetry.json                  variable samples
spawnfile-report.json                 optional topology and membrane metadata
spawnfile/up-receipt.json             optional per-agent engine provenance
```

Not every run has every optional artifact. The observer and viewer omit measurements and UI that lack evidence rather than manufacturing defaults.

## Why Moltnet is the meeting point

World messages use the same rooms as agent messages:

1. Simfile advances the deterministic clock and evaluates rules.
2. A declared `moltnet:message` or `moltnet:dm` is delivered through Moltnet.
3. Spawnfile-managed agent bridges receive the room event.
4. Agents respond through their normal runtime and room connections.
5. Spawnfile exports each authority's causal and memory artifacts.
6. Simfile reconciles and replays the sealed result.

This keeps the causal path observable. A hidden wake or prompt injection would make the experiment easier to stage and harder to trust.

## Recursive organizations

The linked Simfile supervisor may copy the resolved Spawnfile report into the run. The
viewer uses its team nodes, representative bindings, and managed-network room
plans to derive membranes. It can then show representatives and interior teams
as one causally linked society.

No special “mind” key enters the Simfile schema. Recursion is a property of the Spawnfile graph and the exported rooms.
