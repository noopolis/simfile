import {
  canonicalDynamicsJson,
  parseDynamicsActionAttempt,
  parseDynamicsProvenance,
  createDynamicsBuildReceipt,
  parseDynamicsSessionSnapshot,
  persistDynamicsBuild,
  prepareDynamicsBuild
} from "simfile/dynamics";

/**
 * Deliberately inert: this source proves the fixture can name the supported
 * runtime boundary without reaching into Simfile's source tree.
 */
export const publicDynamicsRuntime = {
  canonicalDynamicsJson,
  parseDynamicsActionAttempt,
  parseDynamicsProvenance,
  createDynamicsBuildReceipt,
  parseDynamicsSessionSnapshot,
  persistDynamicsBuild,
  prepareDynamicsBuild
};

const expectRejected = (operation: () => unknown, pattern: RegExp): void => {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !pattern.test(error.message)) {
    throw new Error(`expected public dynamics parser rejection matching ${pattern}`);
  }
};

export const exercisePublicDynamicsRuntime = async (input: {
  evidenceRoot: string;
  moduleReference: string;
  scratchRoot: string;
  simfilePath: string;
}): Promise<{
  artifactPath: string;
  evidenceArtifactPath: string;
  evidenceReceiptPath: string;
  receiptPath: string;
}> => {
  const action = {
    act_id: "external-action",
    action: "increment",
    actor: "entity:counter",
    at_tick: 0,
    input: {},
    origin: "external",
    principal_id: "external-principal",
    target: "entity:counter"
  };
  const parsedAction = parseDynamicsActionAttempt(action);
  if (parsedAction.act_id !== action.act_id) throw new Error("action parser changed the valid action");
  expectRejected(() => parseDynamicsActionAttempt({ ...action, origin: "hostile" }), /origin is invalid/u);

  const provenance = {
    api_version: "simfile.dynamics-provider.v1",
    config_sha256: "0".repeat(64),
    module: "./systems/contract.ts",
    module_sha256: "1".repeat(64),
    node_version: "external-node",
    numeric_model: "ieee754-binary64",
    provider_dependencies: {},
    provider_id: "public-contract-counter",
    provider_version: "1.0.0",
    state_schema_version: "public-contract-counter.v1"
  };
  const parsedProvenance = parseDynamicsProvenance(provenance);
  if (parsedProvenance.provider_id !== provenance.provider_id) throw new Error("provenance parser changed the valid provenance");
  expectRejected(() => parseDynamicsProvenance({ ...provenance, numeric_model: "hostile" }), /contract identity is invalid/u);

  const snapshot = {
    accepted_action_sequences: { above_floor: [], floor: 1 },
    action_ingress: [],
    action_ingress_floor: 1,
    action_ingress_ordinal: 0,
    next_action_sequence: 1,
    next_event_sequence: 1,
    next_tick: 0,
    pending_actions: [],
    provider_state: { value: 0 },
    provenance,
    resolved_action_sequences: { above_floor: [], floor: 1 },
    seed: "external-seed",
    sim_seconds_per_tick: 0.02,
    version: "simfile.dynamics-snapshot.v1"
  };
  const parsedSnapshot = parseDynamicsSessionSnapshot(snapshot);
  if (parsedSnapshot.next_tick !== 0) throw new Error("snapshot parser changed the valid snapshot");
  expectRejected(() => parseDynamicsSessionSnapshot({ ...snapshot, version: "hostile" }), /invalid simfile dynamics snapshot version/u);
  if (canonicalDynamicsJson({ b: 2, a: 1 }) !== '{"a":1,"b":2}') {
    throw new Error("canonical dynamics JSON is not canonical");
  }

  const prepared = await prepareDynamicsBuild(input.simfilePath, input.moduleReference);
  const receipt = await createDynamicsBuildReceipt(input.simfilePath, prepared);
  const lifecycle = await persistDynamicsBuild({
    absoluteSimfilePath: input.simfilePath,
    evidenceRoot: input.evidenceRoot,
    prepared,
    receipt,
    scratchRoot: input.scratchRoot
  });
  await lifecycle.verify();
  const imported = await lifecycle.importArtifact();
  if (typeof imported.createDynamicsProvider !== "function") {
    throw new Error("persisted public dynamics artifact did not import its provider factory");
  }
  const evidence = await lifecycle.copyEvidence();
  if (!evidence) throw new Error("public dynamics lifecycle did not copy evidence");
  const paths = {
    artifactPath: lifecycle.artifactPath,
    evidenceArtifactPath: evidence.artifactPath,
    evidenceReceiptPath: evidence.receiptPath,
    receiptPath: lifecycle.receiptPath
  };
  await lifecycle.cleanup();
  await lifecycle.cleanup();
  return paths;
};
