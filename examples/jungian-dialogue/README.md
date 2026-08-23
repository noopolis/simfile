# Jungian dialogue

An analyst wakes with a dream: a black door, a tarnished mirror, and a lost
child. The analyst asks a daimon what the image demands. The daimon treats the
dream as a threshold rather than a diagnosis, the analyst names the fear
beneath it, and the exchange ends with one bounded act of integration.

This is Simfile's canonical composed example. It has two understandable agents
in one Moltnet room, a finite twelve-tick world, bearer-authenticated world
observation, genuine scripted-engine room messages, sealed evidence, exact
mechanics replay, and the run-replay viewer. It needs no model account or API
key. The viewer says **authored screenplay, not emergent dialogue** because the
words are deterministic; the messages themselves are still real outputs sent
through the Spawnfile-managed Moltnet path and exported from that run.

## Run it

From a clean Simfile checkout, install and build Simfile:

```bash
npm ci
npm run build
```

Install the exact supported Spawnfile package into Simfile's ignored tool
root, then check its public composed-lifecycle contract:

```bash
npm run dev:spawnfile:setup -- --package spawnfile@0.1.17
npm run dev:spawnfile:check
```

For an already packed Spawnfile release, use its physical artifact and digest
instead of the registry coordinate:

```bash
npm run dev:spawnfile:setup -- \
  --artifact /absolute/path/spawnfile-0.1.17.tgz \
  --sha256 <lowercase-sha256>
npm run dev:spawnfile:check
```

Run the bounded composed example against an explicit local Docker context:

```bash
npm run example:composed -- --context colima
```

The command prints a unique sealed run directory. Reconcile it and open the
viewer with the checkout's freshly built CLI:

```bash
node dist/cli/index.js observe runs/<printed-run-id>
node dist/cli/index.js view runs/<printed-run-id>
```

Add `--view` to the composed command to attach the viewer during the run, or
add `--no-open` to the later `view` command on a remote shell.

## What is real, and what is scripted

The first analyst schedule is released by the same topology activation that
starts world ticks. Its engine reads `/spawnfile/world-bindings.json`, claims a
decision with its generated bearer token, and observes `sense:dream` from the
world service. Only then does it send the observed symbols into
`room:dream_lab:consulting-room` with the staged Moltnet CLI. Mentions wake the
other participant and carry the five-message dialogue to its unmentioned final
line.

Spawnfile exports the resulting Moltnet transcript and causal streams. Simfile
does not manufacture those messages. The engine is an authored deterministic
screenplay, so this example demonstrates the world/organization/transport/
evidence/replay path, not spontaneous model interpretation. The explicit
`lifecycle-replay-smoke` receipt also keeps strategic world-action evidence at
`not_evaluated`; neither participant submits a world action in this story.

## Project map

```text
Simfile                         finite dream world and two world grants
binding.mjs                     public composed-project binding
binding-world.mjs               deterministic kernel and replay adapter
org/Spawnfile                   analyst + daimon and the consulting room
harness/jungian-engine.mjs      credential-free five-message screenplay
world/provider.mjs              dream observation and bounded mechanics
world/surface.mjs               public sense:dream projection
world/composer.mjs              timed controller, evidence, terminal signal
world/evidence.mjs              exact replay/evidence encodings
```

The older `examples/composed-development` project remains temporarily as the
internal one-agent lifecycle regression while its references are migrated to
`fixtures/e2e/composed-lifecycle-smoke`. It is not the advertised example.

