import {
  composeWorldRuntimeInput,
  createComposedWorldTerminalSignal,
  createDynamicsSession,
  parseWorldSurfaceDefinition,
  publishComposedWorldTerminalSignal,
  readWorldRuntimeCheckpointCoordinator,
  readWorldRuntimeClockAuthority,
  WORLD_DECISION_CLAIM_CAPABILITY,
} from "./entrypoint.mjs";
import { createDynamicsProvider } from "./provider.mjs";

import {
  acceptedActionsBytes,
  actionStreamBytes,
  checkpointBytes,
  framesBytes,
  jsonBytes,
  principalsBytes,
  probeBytes,
  replayExpectationBytes,
  sha256,
  terminalStateBytes,
  writeEvidenceFiles,
} from "./evidence.mjs";
import { createWorldSurfaceDefinition } from "./surface.mjs";

const RUN_ID = __RUN_ID__;
const SEED = __SEED__;
const TERMINAL_TICK = __TERMINAL_TICK__;
const WORLD_INSTANCE_ID = __WORLD_INSTANCE_ID__;
const participants = ["analyst", "daimon"];
const principalResolver = Object.freeze({
  resolveParticipant: (principal) => participants.find(
    (participant) => principal === `agent:${participant}`,
  ),
  resolvePrincipal: (participant) => participants.includes(participant)
    ? `agent:${participant}` : undefined,
});
const createSession = () => createDynamicsSession(createDynamicsProvider(), {
  buildReceipt: __BUILD_RECEIPT__,
  config: __PROVIDER_CONFIG__,
  provenance: __PROVIDER_PROVENANCE__,
  seed: SEED,
  simSecondsPerTick: __SIM_SECONDS_PER_TICK__,
});
const equalBytes = (left, right) => left.byteLength === right.byteLength
  && left.every((value, index) => value === right[index]);
const capture = (runtime) => {
  const coordinator = readWorldRuntimeCheckpointCoordinator(runtime);
  if (coordinator === undefined) {
    throw new Error("jungian dialogue checkpoint authority is unavailable");
  }
  return coordinator.capture();
};

export const composeWorldRuntime = () => composeWorldRuntimeInput({
  principalResolver,
  runId: RUN_ID,
  session: createSession(),
  surfaceRegistry: parseWorldSurfaceDefinition(createWorldSurfaceDefinition()),
  world: __WORLD__,
  worldInstanceId: WORLD_INSTANCE_ID,
});
export const proveWorldRuntimeReadiness = (runtime) => {
  const checkpoint = capture(runtime);
  if (checkpoint.dynamics.next_tick !== 0
    || checkpoint.decisions.decisions.length !== 0) {
    throw new Error("jungian dialogue world is not pristine");
  }
};

const expectedEvidence = (initial) => {
  const replay = createSession();
  replay.restore(initial.dynamics);
  const snapshots = [replay.snapshot()];
  for (let step = replay.nextTick; step < TERMINAL_TICK; step += 1) {
    replay.step();
    snapshots.push(replay.snapshot());
  }
  if (replay.nextTick !== TERMINAL_TICK) {
    throw new Error("jungian dialogue replay missed its terminal tick");
  }
  const initialBytes = checkpointBytes(initial);
  const actions = actionStreamBytes();
  const probe = probeBytes(RUN_ID, TERMINAL_TICK);
  const terminal = terminalStateBytes(snapshots.at(-1));
  return {
    files: [
      ["actions/accepted-strategic-actions.json", acceptedActionsBytes(RUN_ID)],
      ["actions/replay-accepted-actions.jsonl", actions],
      ["actions/results.jsonl", new Uint8Array()],
      ["checkpoints/initial.json", initialBytes],
      ["projections/frames.jsonl", framesBytes(snapshots)],
      ["projections/lifecycle-replay-probe.json", probe],
      ["projections/principals.json", principalsBytes(RUN_ID)],
      ["projections/replay-expected.json", replayExpectationBytes({
        action_stream: actions, initial_checkpoint: initialBytes, probe,
        terminal_state: terminal, terminal_tick: TERMINAL_TICK,
      })],
      ["projections/terminal-state.json", terminal],
    ],
    snapshots,
    terminal,
  };
};

export const startWorldRuntime = (runtime, activation) => {
  const initial = capture(runtime);
  let stop;
  let cancelDelay = () => {};
  let stopped = false;
  const stopping = new Promise((resolve) => { stop = resolve; });
  const waitForNextTick = () => new Promise((resolve) => {
    const timer = setTimeout(() => { cancelDelay = () => {}; resolve(true); }, 1_000);
    cancelDelay = () => { clearTimeout(timer); cancelDelay = () => {}; resolve(false); };
  });
  const done = (async () => {
    const activated = await Promise.race([
      activation.ready.then(() => true),
      stopping.then(() => false),
    ]);
    if (!activated || stopped) return;
    const expectation = expectedEvidence(initial);
    await writeEvidenceFiles(__EVIDENCE_ROOT__, expectation.files);
    const clock = readWorldRuntimeClockAuthority(runtime);
    if (clock === undefined) throw new Error("jungian dialogue clock is unavailable");
    while (!stopped && capture(runtime).dynamics.next_tick < TERMINAL_TICK) {
      if (!await waitForNextTick() || stopped) break;
      const before = capture(runtime).dynamics.next_tick;
      clock.stepDynamics();
      const observed = capture(runtime).dynamics;
      if (observed.next_tick !== before + 1
        || !equalBytes(jsonBytes(observed), jsonBytes(expectation.snapshots[observed.next_tick]))) {
        throw new Error("jungian dialogue live mechanics diverged from replay");
      }
    }
    if (!stopped && capture(runtime).dynamics.next_tick !== TERMINAL_TICK) {
      throw new Error("jungian dialogue world missed its terminal tick");
    }
    if (!stopped) {
      await writeEvidenceFiles(__EVIDENCE_ROOT__, [[
        "checkpoints/terminal.json", checkpointBytes(capture(runtime)),
      ]]);
      await publishComposedWorldTerminalSignal(createComposedWorldTerminalSignal({
        outcome_digest: `sha256:${sha256(expectation.terminal)}`,
        reason: "completed",
        run_id: RUN_ID,
        terminal_tick: TERMINAL_TICK,
      }));
    }
  })();
  void done.catch((error) => process.nextTick(() => { throw error; }));
  return Object.freeze({
    close: async () => {
      stopped = true;
      cancelDelay();
      stop();
      await done;
    },
  });
};

export const worldRuntimeCapabilities = Object.freeze([
  WORLD_DECISION_CLAIM_CAPABILITY,
]);

