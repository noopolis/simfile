import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type { DynamicsJsonObject } from "../dynamics/types.js";
import {
  cloneStableDynamicsJsonObject,
  nullPrototypeRecord,
  ownDataValue
} from "./own-data.js";
import type {
  ReadonlyWorldSurfaceObservation,
  ReadonlyWorldSurfaceObservationChannel
} from "./types.js";
import { assertWorldObservationRecommendation } from "./recommendation.js";

const MECHANICS_ADDRESS = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_.-]*)+$/u;
const MECHANICS_NAME = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)*$/u;

const exactJsonObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string
): DynamicsJsonObject => {
  const record = cloneStableDynamicsJsonObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown field ${key}`);
  }
  for (const field of required) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`${path}.${field} is required`);
  }
  return record;
};

const canonicalString = (
  value: unknown,
  path: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || value.length === 0
    || value.length > DYNAMICS_LIMITS.identifier_code_units
    || !pattern.test(value)) {
    throw new TypeError(`${path} must be a bounded canonical string`);
  }
  return value;
};

const parseComponents = (
  value: unknown,
  path: string
): Readonly<Record<string, number>> => {
  const record = cloneStableDynamicsJsonObject(value, path);
  const entries = Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (entries.length === 0
    || entries.length > DYNAMICS_LIMITS.observation_components_per_channel) {
    throw new TypeError(`${path} must be a bounded non-empty component object`);
  }
  const components: Array<readonly [string, number]> = [];
  for (const [key, component] of entries) {
    canonicalString(key, `${path} key`, MECHANICS_NAME);
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new TypeError(`${path}.${key} must be finite`);
    }
    components.push([key, component]);
  }
  return Object.freeze(nullPrototypeRecord(components));
};

const parseChannel = (
  value: unknown,
  path: string
): ReadonlyWorldSurfaceObservationChannel => {
  const record = exactJsonObject(
    value,
    ["components", "sense_address", "subject_address"],
    ["frame", "unit"],
    path
  );
  const frame = ownDataValue(record, "frame");
  const unit = ownDataValue(record, "unit");
  const entries: Array<readonly [string, unknown]> = [
    ["components", parseComponents(
      ownDataValue(record, "components"),
      `${path}.components`
    )],
    ["sense_address", canonicalString(
      ownDataValue(record, "sense_address"),
      `${path}.sense_address`,
      MECHANICS_ADDRESS
    )],
    ["subject_address", canonicalString(
      ownDataValue(record, "subject_address"),
      `${path}.subject_address`,
      MECHANICS_ADDRESS
    )]
  ];
  if (frame !== undefined) {
    entries.push(["frame", canonicalString(frame, `${path}.frame`, MECHANICS_ADDRESS)]);
  }
  if (unit !== undefined) {
    entries.push(["unit", canonicalString(unit, `${path}.unit`, MECHANICS_NAME)]);
  }
  const parsed = Object.freeze(
    nullPrototypeRecord(entries)
  ) as unknown as ReadonlyWorldSurfaceObservationChannel;
  assertWorldObservationRecommendation(parsed.components, parsed.unit, path);
  return parsed;
};

export const parseWorldSurfaceObservation = (
  value: unknown,
  path: string
): ReadonlyWorldSurfaceObservation => {
  const record = exactJsonObject(value, ["channels"], [], path);
  const channelInput = ownDataValue(record, "channels");
  if (!Array.isArray(channelInput)
    || channelInput.length > DYNAMICS_LIMITS.observation_channels) {
    throw new TypeError(`${path}.channels must be a bounded array`);
  }
  const channels = channelInput.map((channel, index) =>
    parseChannel(channel, `${path}.channels[${index}]`));
  const identities = channels.map((channel) =>
    [channel.sense_address, channel.subject_address, channel.frame ?? "", channel.unit ?? ""]
      .join("\0"));
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${path}.channels must have unique addresses`);
  }
  const componentCount = channels.reduce(
    (total, channel) => total + Object.keys(channel.components).length,
    0
  );
  if (componentCount > DYNAMICS_LIMITS.json_nodes) {
    throw new TypeError(`${path} exceeds the total observation component limit`);
  }
  return Object.freeze(nullPrototypeRecord([
    ["channels", Object.freeze(channels)]
  ])) as unknown as ReadonlyWorldSurfaceObservation;
};
