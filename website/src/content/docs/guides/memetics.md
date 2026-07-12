---
title: Memetics Experiment
description: Inspect the seeded-secret experiment and its controls.
---

This experiment asks a narrow question: can an idea placed in one AI agent's private memory reach another agent without a scripted handoff?

The result was reproducible. In five of five real-engine runs, the seeded token surfaced in conversation and reached the second agent. No prompt told either agent to share it.

![The Simfile viewer showing the seeded idea reaching a second agent.](/shots/viewer-memetics.png)

## Controls

| Condition | Private seed | Result |
|---|---|---|
| Seeded · 5 runs | the secret | reached the second agent, 5/5 |
| Replacement control | a different secret | the replacement spread; the original stayed absent |
| Unseeded control | nothing | the token never appeared |

The replacement control tests whether the harness was leaking the original token. The unseeded control tests whether it appeared without being planted. Both controls held.

## What Simfile measures

Simfile measures channel, reach, latency, and fidelity per run. It derives those measurements again from the sealed ledger instead of trusting a verdict from the experiment harness.

Every viewer claim points back to a record. The run header also discloses whether the dialogue came from a real engine or a scripted fixture.

## Inspect a run

After running a compatible experiment, derive its report and open the same sealed artifacts in the viewer:

```bash
simfile observe runs/latest
simfile view runs/latest
```

The observer writes causal chains and spread measurements to `report.json`. In the viewer, one timeline cursor rewinds the conversation, agent memory, and causal traces together.

Start with the [quickstart](/quickstart/) to declare and validate a world.
