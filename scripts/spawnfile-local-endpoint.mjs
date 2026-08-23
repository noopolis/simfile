import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { runBoundedProcess } from "./bounded-process.mjs";

const digest = /^sha256:[a-f0-9]{64}$/u;
const contextName = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (message) => { throw new TypeError(message); };

export const parseSpawnfileLocalEndpointProof = (raw, expectedContext) => {
  const value = raw;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.version !== "spawnfile.target-config-resolution.v1"
    || value.context_selection !== "explicit"
    || value.endpoint?.class !== "local"
    || !["fd", "npipe", "unix"].includes(value.endpoint?.transport)
    || value.platform?.os !== "linux"
    || !["amd64", "arm64"].includes(value.platform?.architecture)
    || value.target_config?.context !== expectedContext
    || value.target_config?.version !== "spawnfile.target-default-config.v1"
    || !digest.test(value.target_config_digest ?? "")
    || !digest.test(value.base_image?.config_digest ?? "")) {
    return fail("Spawnfile did not prove the exact context is a local endpoint");
  }
  return Object.freeze({
    architecture: value.platform.architecture,
    context: expectedContext,
    endpoint_class: "local",
    transport: value.endpoint.transport,
    version: "simfile.spawnfile-local-endpoint-proof.v1",
  });
};

export const proveSpawnfileLocalEndpoint = async (input) => {
  if (typeof input.spawnfile_bin !== "string" || !path.isAbsolute(input.spawnfile_bin)
    || path.normalize(input.spawnfile_bin) !== input.spawnfile_bin
    || !contextName.test(input.context ?? "")) {
    return fail("Local endpoint proof requires an absolute Spawnfile bin and exact context");
  }
  const root = await mkdtemp(path.join(input.state_root, ".endpoint-proof-"));
  try {
    const args = ["target", "resolve_config", "--context", input.context,
      "--evidence-destination", path.join(root, "world-evidence.tar"),
      "--timeout-ms", "120000"];
    if (input.base_image !== undefined) args.push("--base-image", input.base_image);
    if (input.docker_command !== undefined) {
      args.push("--docker-command", input.docker_command);
    }
    const result = await runBoundedProcess(input.spawnfile_bin, args, {
      cwd: input.cwd, env: input.env, timeoutMs: 120_000,
    });
    let raw;
    try { raw = JSON.parse(result.stdout); }
    catch { return fail("Spawnfile local endpoint proof did not emit JSON"); }
    return parseSpawnfileLocalEndpointProof(raw, input.context);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
