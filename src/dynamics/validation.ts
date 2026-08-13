import {
  DYNAMICS_OBSERVATION_VERSION,
  DYNAMICS_PROVIDER_API_VERSION,
  type DynamicsActionAttempt,
  type DynamicsActionResolution,
  type DynamicsCommand,
  type DynamicsEventDraft,
  type DynamicsJsonObject,
  type DynamicsObservation,
  type DynamicsObservationChannel,
  type DynamicsObservationRequest,
  type DynamicsProvider,
  type DynamicsProviderStepResult,
  type DynamicsProvenance
} from "./types.js";
import { cloneDynamicsJson, cloneDynamicsJsonObject } from "./canonicalJson.js";
import { parseDynamicsCommitmentOutcomeDrafts } from "./commitmentOutcomes.js";
import { DYNAMICS_LIMITS } from "./limits.js";

const ADDRESS_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_.-]*)+$/u;
const NAME_PATTERN = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const assertOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new Error(`${path} contains unknown field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${path}.${key} must be an enumerable data value`);
    }
  }
};

const boundedString = (value: unknown, path: string, limit: number): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  cloneDynamicsJson(value, path);
  if (value.length > limit) throw new Error(`${path} exceeds the ${limit} code-unit limit`);
  return value;
};

const nonEmptyString = (value: unknown, path: string): string =>
  boundedString(value, path, DYNAMICS_LIMITS.identifier_code_units);

const namedString = (value: unknown, path: string): string => {
  const parsed = nonEmptyString(value, path);
  if (!NAME_PATTERN.test(parsed)) {
    throw new Error(`${path} must be a canonical name`);
  }
  return parsed;
};

const addressString = (value: unknown, path: string): string => {
  const parsed = nonEmptyString(value, path);
  if (!ADDRESS_PATTERN.test(parsed)) {
    throw new Error(`${path} must be a canonical address such as object:ball`);
  }
  return parsed;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return Object.is(value, -0) ? 0 : value as number;
};

const positiveInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
};

const sha256String = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${path} must be a SHA-256 digest`);
  }
  return value;
};

const codePointCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const parseDynamicsSeed = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("dynamics seed must be a non-empty string");
  }
  cloneDynamicsJson(value, "dynamics seed");
  if (value.length > DYNAMICS_LIMITS.identifier_code_units) {
    throw new Error("dynamics seed exceeds the dynamics identifier code-unit limit");
  }
  return value;
};

export const parseDynamicsActionAttempt = (value: unknown): DynamicsActionAttempt => {
  const record = cloneDynamicsJsonObject(value, "dynamics action attempt");
  assertOnlyKeys(record, ["act_id", "action", "actor", "at_tick", "input", "origin", "principal_id", "target"], "dynamics action attempt");
  const origin = record.origin;
  if (origin !== "agentic" && origin !== "controller" && origin !== "external" && origin !== "replay") {
    throw new Error("dynamics action attempt.origin is invalid");
  }
  return {
    act_id: nonEmptyString(record.act_id, "dynamics action attempt.act_id"),
    action: namedString(record.action, "dynamics action attempt.action"),
    actor: addressString(record.actor, "dynamics action attempt.actor"),
    at_tick: nonNegativeInteger(record.at_tick, "dynamics action attempt.at_tick"),
    input: cloneDynamicsJsonObject(record.input, "dynamics action attempt.input"),
    origin,
    principal_id: nonEmptyString(record.principal_id, "dynamics action attempt.principal_id"),
    target: addressString(record.target, "dynamics action attempt.target")
  };
};

const parseResolution = (value: unknown, path: string): DynamicsActionResolution => {
  if (!isRecord(value) || typeof value.accepted !== "boolean") {
    throw new Error(`${path} must declare accepted as a boolean`);
  }
  assertOnlyKeys(value, ["accepted", "code", "message", "sequence"], path);
  const code = value.code === undefined ? undefined : namedString(value.code, `${path}.code`);
  if (value.accepted && code !== undefined) throw new Error(`${path} accepted result cannot declare code`);
  if (!value.accepted && code === undefined) throw new Error(`${path} rejected result must declare code`);
  return {
    accepted: value.accepted,
    ...(code ? { code } : {}),
    ...(value.message === undefined ? {} : {
      message: boundedString(value.message, `${path}.message`, DYNAMICS_LIMITS.message_code_units)
    }),
    sequence: positiveInteger(value.sequence, `${path}.sequence`)
  };
};

const parseEventDraft = (value: unknown, path: string, nextActionSequence: number): DynamicsEventDraft => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertOnlyKeys(value, ["cause_action_sequences", "kind", "payload", "source", "target"], path);
  if (
    !Array.isArray(value.cause_action_sequences)
    || value.cause_action_sequences.length > DYNAMICS_LIMITS.causes_per_event
  ) throw new Error(`${path}.cause_action_sequences exceeds the cause limit`);
  const causeActionSequences = value.cause_action_sequences.map((sequence, index) =>
    positiveInteger(sequence, `${path}.cause_action_sequences[${index}]`));
  if (new Set(causeActionSequences).size !== causeActionSequences.length) {
    throw new Error(`${path}.cause_action_sequences must be unique`);
  }
  for (const sequence of causeActionSequences) {
    if (sequence >= nextActionSequence) throw new Error(`${path} references unknown action sequence ${sequence}`);
  }
  return {
    cause_action_sequences: causeActionSequences,
    kind: namedString(value.kind, `${path}.kind`),
    payload: cloneDynamicsJsonObject(value.payload, `${path}.payload`),
    source: addressString(value.source, `${path}.source`),
    target: addressString(value.target, `${path}.target`)
  };
};

export const parseDynamicsStepResult = (
  value: unknown,
  expectedTick: number,
  actions: readonly DynamicsCommand[],
  nextActionSequence: number
): DynamicsProviderStepResult => {
  const record = cloneDynamicsJsonObject(value, "dynamics step result");
  assertOnlyKeys(record, ["action_results", "commitment_outcomes", "events", "tick"], "dynamics step result");
  if (record.tick !== expectedTick) throw new Error(`dynamics step result tick must equal ${expectedTick}`);
  if (!Array.isArray(record.action_results) || record.action_results.length !== actions.length) {
    throw new Error("dynamics step result must resolve every queued action exactly once");
  }
  const actionResults = record.action_results.map((result, index) => {
    const parsed = parseResolution(result, `dynamics step result.action_results[${index}]`);
    if (parsed.sequence !== actions[index]?.sequence) {
      throw new Error("dynamics action results must preserve canonical command order");
    }
    return parsed;
  });
  if (!Array.isArray(record.events) || record.events.length > DYNAMICS_LIMITS.events_per_tick) {
    throw new Error("dynamics step result.events exceeds the per-tick event limit");
  }
  const commitmentOutcomes = record.commitment_outcomes === undefined
    ? undefined
    : parseDynamicsCommitmentOutcomeDrafts(record.commitment_outcomes);
  if (record.events.length + (commitmentOutcomes?.length ?? 0)
    > DYNAMICS_LIMITS.events_per_tick) {
    throw new Error("dynamics step result events and commitment outcomes exceed the per-tick event limit");
  }
  return {
    action_results: actionResults,
    ...(commitmentOutcomes === undefined ? {} : {
      commitment_outcomes: commitmentOutcomes,
    }),
    events: record.events.map((event, index) => parseEventDraft(event, `dynamics step result.events[${index}]`, nextActionSequence)),
    tick: expectedTick
  };
};

export const parseDynamicsObservationRequest = (value: unknown): DynamicsObservationRequest => {
  const record = cloneDynamicsJsonObject(value, "dynamics observation request");
  assertOnlyKeys(record, ["observer", "principal_id", "sense_addresses"], "dynamics observation request");
  if (
    !Array.isArray(record.sense_addresses)
    || record.sense_addresses.length === 0
    || record.sense_addresses.length > DYNAMICS_LIMITS.sense_grants
  ) {
    throw new Error("dynamics observation request.sense_addresses exceeds the sense grant limit");
  }
  const senseAddresses = record.sense_addresses.map((address, index) =>
    addressString(address, `dynamics observation request.sense_addresses[${index}]`));
  if (new Set(senseAddresses).size !== senseAddresses.length) {
    throw new Error("dynamics observation request.sense_addresses must be unique");
  }
  return {
    observer: addressString(record.observer, "dynamics observation request.observer"),
    principal_id: nonEmptyString(record.principal_id, "dynamics observation request.principal_id"),
    sense_addresses: [...senseAddresses].sort(codePointCompare)
  };
};

const parseObservationChannel = (value: unknown, path: string, granted: ReadonlySet<string>): DynamicsObservationChannel => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertOnlyKeys(value, ["components", "frame", "sense_address", "subject_address", "unit"], path);
  const senseAddress = addressString(value.sense_address, `${path}.sense_address`);
  if (!granted.has(senseAddress)) throw new Error(`${path} returned an ungranted sense address`);
  const raw = cloneDynamicsJsonObject(value.components, `${path}.components`);
  const entries = Object.entries(raw).sort(([left], [right]) => codePointCompare(left, right));
  if (entries.length === 0 || entries.length > DYNAMICS_LIMITS.observation_components_per_channel) {
    throw new Error(`${path}.components exceeds the component limit`);
  }
  const components: Record<string, number> = {};
  for (const [key, component] of entries) {
    const parsedKey = namedString(key, `${path}.components key`);
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error(`${path}.components.${key} must be a named finite number`);
    }
    components[parsedKey] = component;
  }
  return {
    components,
    ...(value.frame === undefined ? {} : { frame: addressString(value.frame, `${path}.frame`) }),
    sense_address: senseAddress,
    subject_address: addressString(value.subject_address, `${path}.subject_address`),
    ...(value.unit === undefined ? {} : { unit: namedString(value.unit, `${path}.unit`) })
  };
};

export const parseDynamicsObservation = (
  value: unknown,
  request: DynamicsObservationRequest,
  tick: number
): DynamicsObservation => {
  const record = cloneDynamicsJsonObject(value, "dynamics provider observation");
  assertOnlyKeys(record, ["channels"], "dynamics provider observation");
  if (!Array.isArray(record.channels) || record.channels.length > DYNAMICS_LIMITS.observation_channels) {
    throw new Error("dynamics observation.channels exceeds the channel limit");
  }
  const granted = new Set(request.sense_addresses);
  const channels = record.channels.map((channel, index) =>
    parseObservationChannel(channel, `dynamics observation.channels[${index}]`, granted)
  ).sort((left, right) => codePointCompare(
    [left.sense_address, left.subject_address, left.frame ?? "", left.unit ?? ""].join("\0"),
    [right.sense_address, right.subject_address, right.frame ?? "", right.unit ?? ""].join("\0")
  ));
  const channelKeys = channels.map((channel) =>
    [channel.sense_address, channel.subject_address, channel.frame ?? "", channel.unit ?? ""].join("\0"));
  if (new Set(channelKeys).size !== channels.length) {
    throw new Error("dynamics observation channel addresses must be unique");
  }
  if (
    channels.reduce((total, channel) => total + Object.keys(channel.components).length, 0)
    > DYNAMICS_LIMITS.json_nodes
  ) throw new Error("dynamics observation exceeds the total component limit");
  return {
    channels,
    observer: request.observer,
    principal_id: request.principal_id,
    tick,
    version: DYNAMICS_OBSERVATION_VERSION
  };
};

const parseStringRecord = (value: unknown, path: string): Record<string, string> => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const cloned = cloneDynamicsJsonObject(value, path);
  if (Object.keys(cloned).length > DYNAMICS_LIMITS.sense_grants) {
    throw new Error(`${path} exceeds the dependency entry limit`);
  }
  return Object.fromEntries(Object.entries(cloned).sort(([left], [right]) => codePointCompare(left, right)).map(([key, entry]) => [
    nonEmptyString(key, `${path} key`),
    nonEmptyString(entry, `${path}.${key}`)
  ]));
};

export const assertDynamicsProvider: (value: unknown) => asserts value is DynamicsProvider = (value) => {
  if (!isRecord(value)) throw new Error("createDynamicsProvider must return an object");
  if (value.api_version !== DYNAMICS_PROVIDER_API_VERSION) {
    throw new Error(`dynamics provider.api_version must be ${DYNAMICS_PROVIDER_API_VERSION}`);
  }
  namedString(value.id, "dynamics provider.id");
  parseDynamicsIntegration(value.integration);
  nonEmptyString(value.version, "dynamics provider.version");
  nonEmptyString(value.state_schema_version, "dynamics provider.state_schema_version");
  parseStringRecord(value.dependencies, "dynamics provider.dependencies");
  for (const method of ["initialize", "observe", "restore", "snapshot", "step"] as const) {
    if (typeof value[method] !== "function") throw new Error(`dynamics provider must implement ${method}()`);
    if (value[method].constructor.name === "AsyncFunction") {
      throw new Error(`dynamics provider ${method}() must be synchronous`);
    }
  }
  // Optional: absence is a supported provider shape (no motion recorded), so
  // only a present-but-wrong `spatial` is an error.
  if (value.spatial !== undefined) {
    if (typeof value.spatial !== "function") {
      throw new Error("dynamics provider spatial() must be a function");
    }
    if (value.spatial.constructor.name === "AsyncFunction") {
      throw new Error("dynamics provider spatial() must be synchronous");
    }
  }
};

export const parseDynamicsIntegration = (value: unknown): DynamicsJsonObject =>
  cloneDynamicsJsonObject(value === undefined ? {} : value, "dynamics provider.integration");

export const parseDynamicsProvenance = (value: unknown): DynamicsProvenance => {
  const record = cloneDynamicsJsonObject(value, "dynamics provenance");
  assertOnlyKeys(record, ["api_version", "config_sha256", "module", "module_sha256", "node_version", "numeric_model", "provider_dependencies", "provider_id", "provider_version", "state_schema_version"], "dynamics provenance");
  if (record.api_version !== DYNAMICS_PROVIDER_API_VERSION || record.numeric_model !== "ieee754-binary64") {
    throw new Error("dynamics provenance contract identity is invalid");
  }
  return {
    api_version: DYNAMICS_PROVIDER_API_VERSION,
    config_sha256: sha256String(record.config_sha256, "dynamics provenance.config_sha256"),
    module: nonEmptyString(record.module, "dynamics provenance.module"),
    module_sha256: sha256String(record.module_sha256, "dynamics provenance.module_sha256"),
    node_version: nonEmptyString(record.node_version, "dynamics provenance.node_version"),
    numeric_model: "ieee754-binary64",
    provider_dependencies: parseStringRecord(record.provider_dependencies, "dynamics provenance.provider_dependencies"),
    provider_id: namedString(record.provider_id, "dynamics provenance.provider_id"),
    provider_version: nonEmptyString(record.provider_version, "dynamics provenance.provider_version"),
    state_schema_version: nonEmptyString(record.state_schema_version, "dynamics provenance.state_schema_version")
  };
};

export const providerDependencies = (provider: DynamicsProvider): Record<string, string> =>
  parseStringRecord(provider.dependencies, "dynamics provider.dependencies");
