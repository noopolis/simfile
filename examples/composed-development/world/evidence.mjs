import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const encoder = new TextEncoder();

const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      normalized(value[key]),
    ]));
  }
  return value;
};

export const jsonBytes = (value) =>
  encoder.encode(`${JSON.stringify(normalized(value))}\n`);

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export const acceptedActionsBytes = (runId) => jsonBytes({
  actions: [],
  run_id: runId,
  version: "simfile.accepted-strategic-actions.v1",
});

export const actionStreamBytes = () => new Uint8Array();

export const checkpointBytes = (checkpoint) => jsonBytes(checkpoint);

export const framesBytes = (snapshots) => encoder.encode(snapshots.map(
  (dynamics) => JSON.stringify(normalized({
    dynamics,
    next_tick: dynamics.next_tick,
    version: "simfile.composed-lifecycle-frame.v1",
  })),
).join("\n") + "\n");

export const principalsBytes = (runId) => jsonBytes({
  principals: [{ participant: "smoke", principal: "agent:smoke" }],
  run_id: runId,
  version: "simfile.composed-principals.v1",
});

export const probeBytes = (runId, terminalTick) => jsonBytes({
  live_agent_action: "not_evaluated",
  passed: true,
  run_id: runId,
  terminal_tick: terminalTick,
  version: "simfile.composed-lifecycle-replay-smoke.v1",
});

export const terminalStateBytes = (dynamics) => jsonBytes({
  dynamics,
  version: "simfile.composed-lifecycle-replay-terminal.v1",
});

export const replayExpectationBytes = (input) => jsonBytes({
  accepted_action_count: 0,
  action_stream_sha256: sha256(input.action_stream),
  initial_checkpoint_sha256: sha256(input.initial_checkpoint),
  probe_sha256: sha256(input.probe),
  terminal_state_sha256: sha256(input.terminal_state),
  terminal_tick: input.terminal_tick,
  version: "simfile.composed-replay-expectation.v1",
});

export const writeEvidenceFiles = async (root, files) => {
  for (const [relative, bytes] of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
};
