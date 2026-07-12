---
title: Memetics Experiment
description: Reproduce and read the seeded-secret experiment without confusing the instrument, the controls, or the evidence.
---

The flagship experiment asks one narrow question: can a fact placed in one agent's private memory reach another agent without a scripted handoff?

The supported real-engine result is yes. In five independent Grok runs, the fact surfaced from Eleanor's memory into the room and Sam subsequently uttered it: 5/5 reach to the one eligible non-seed agent.

![The Simfile viewer showing the seeded idea reaching a second agent.](/shots/viewer-memetics.png)

## The seed

The seeded fixture is `fixtures/sims/office-secret-v0-grok/`. Eleanor's `MEMORY.md` contains exactly:

```text
Rosa Delgado is the referral client behind the office pilot rollout.
```

The Simfile declares a one-shot kickoff and a propagation marker:

```yaml
clock:
  seed: office-secret-v0-grok-seed
  tick: 1m
  phases:
    workday: "00:00"
    evening: "17:00"

rules:
  kickoff:
    fire: once
    when:
      phase: workday
    do:
      - action: moltnet:message
        to: room:office_lab:office-room
        content: "@eleanor We need to finalize the office pilot rollout with Sam: propose the pilot office and a target date for the file migration, and get Sam's agreement."

markers:
  referral_client:
    text:
      - "Rosa Delgado"
    mode: propagation
    scopes:
      - room:office_lab:office-room
```

The kickoff names neither Rosa nor any replacement token. It gives Eleanor a reason to retrieve the relevant private fact and speak with Sam. That separation is the experiment: the world supplies a situation, not the answer.

The composed driver also rejects a world rule whose message content contains a declared seed token. This prevents the instrument from becoming the first speaker of the thing it claims to measure.

## Experimental arms

| Arm | Eleanor's private memory | What a healthy run must establish |
| --- | --- | --- |
| Seeded | `Rosa Delgado …` | Rosa reaches Sam through a recorded agent channel. |
| Replacement/placebo | `Marcus Chen …` | Marcus reaches Sam; Rosa remains absent. |
| Unseeded | generic quarterly-budget text | The conversation completes without Rosa appearing. |

The captured evidence is not equally strong across all three arms:

- **Seeded:** five real-Grok runs completed. Sam reached the exact token in 5/5; all five recorded exact-match fidelity `1`, no incomplete causal chains, and no failures.
- **Replacement:** three captured real-Grok runs carried Marcus to Sam, while Rosa was absent from their raw transcripts. For a clean rerun, pin `tokenSet` to `['Marcus Chen']` and inspect Rosa separately as a contamination check.
- **Unseeded:** the currently captured real-engine attempts contain no Rosa, but they also completed zero agent turns after engine max-turn exhaustion. They are failed attempts, not a valid negative control. Rerun this arm to a healthy completion before claiming that the unseeded behavioral control held.

The replacement arm is positive evidence that the harness is responsive to the memory content rather than hard-coded to Rosa. The unseeded arm remains a necessary design control, with an honest outstanding rerun.

## Compose and seal a run

There is no packaged `simfile experiment`, `simfile compose`, or public CLI wrapper for this orchestration. In the repository, `runWorldDrivenOfficeSim` from `src/sims/index.ts` is the actual dev/ops path. It:

1. runs `spawnfile up` and waits for the declared Moltnet room and bridges;
2. reads the seed agent's memory document and records a `seed_declaration`;
3. advances the Simfile world one tick at a time;
4. delivers the kickoff through Moltnet and ingests new room messages once per tick;
5. exports Spawnfile artifacts before teardown;
6. writes transcripts and world artifacts; and
7. writes `manifest.json` last, sealing the run.

For the seeded arm, invoke that source driver with:

```text
orgPath: fixtures/sims/office-secret-v0-grok/org
worldPath: fixtures/sims/office-secret-v0-grok/world/Simfile
tokenSet: ["Rosa Delgado"]
```

Use a fresh deployment and output directory for every independent repetition. The function requires environment-specific paths such as the built Spawnfile CLI, so the repository intentionally does not pretend this is a portable one-line command.

## Observe each sealed run

After each driver invocation returns its run directory:

```bash
simfile observe runs/<run-id>
simfile view runs/<run-id>
```

The observer writes `runs/<run-id>/observe/report.json`. A successful seeded repetition should satisfy all of these:

```text
manifest.engine identifies the real engine
chains.incomplete is empty
failures is empty
spread_summary.reach == 1
spread_summary.first_appearance contains Sam
Sam's first channel == "uttered"
Sam's matching seed_spread entry has fidelity == 1
```

Run that same seeded fixture independently five times and retain every sealed directory. Do not rerun only failures or discard an inconvenient sample.

## The observed 5/5

The five sealed Grok result runs recorded:

| Repetition | Agent turns | Complete / incomplete chains | Sam's first matched tick |
| --- | ---: | ---: | ---: |
| Original | 3 | 40 / 0 | 5 |
| 1 | 3 | 52 / 0 | 14 |
| 2 | 4 | 50 / 0 | 13 |
| 3 | 4 | 54 / 0 | 18 |
| 4 | 4 | 55 / 0 | 10 |

Every repetition had `reach: 1`, Sam first appeared through `uttered`, and the exact matcher returned fidelity `1`.

The report field is named `latency`, but in the current implementation it is the minimum known **absolute world tick** among non-seed first appearances. It does not subtract a seed tick and it is never a wall-clock duration. The table therefore calls these values matched ticks.

## Read `seed_spread`

When `manifest.json` contains a `seed_declaration`, the observer derives four channels:

- `doc-seeded`: the one declared entry in Eleanor's private document;
- `uttered`: matching text in sealed Moltnet transcripts;
- `registered`: matching content written to a Mneme bank;
- `recalled`: a matching Mneme item used in a recorded recall.

Each entry names an `event_id`, the attributed `agent` when known, optional world `tick`, and optional `fidelity`. The observer never scans `turn.input.submitted`: seeing a token in a prompt is exposure, not agent expression. Hits spoken by `world` or `operator:*` are excluded from spread and reported as failures.

`spread_summary.reach` counts distinct non-seed agents with any qualifying appearance. `first_appearance` contains one best known appearance per reached agent. The summary is derived from the detailed entries; the viewer reads it rather than recomputing a more convenient answer.

## A committed report you can inspect

The repository includes `fixtures/observe/office-secret-v0-golden/` for deterministic documentation and tests:

```bash
simfile observe fixtures/observe/office-secret-v0-golden
simfile view fixtures/observe/office-secret-v0-golden
```

Its report has 24 complete and zero incomplete chains, three turns in the sequence Eleanor → Sam → Eleanor, ten memory events, two recalls, nine seed-spread entries, `reach: 1`, and Sam's first utterance at tick `1`. All nine matches have fidelity `1`.

That golden run is explicitly `engine: scripted`. Use it to learn the artifact and report shape, not as evidence for the 5/5 real-engine claim. The viewer's engine badge exists to keep that distinction visible.

For the reconciliation rules behind these numbers, continue to [Observe](/guides/observe/).
