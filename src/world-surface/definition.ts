import { cloneDynamicsJson } from "../dynamics/canonicalJson.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import {
  parseLocalResourceReference,
  type LocalResourceReference,
  type WorldResourceKind
} from "../world/addresses.js";
import {
  assertNoWorldActionSchemaAuthorityFields,
  assertNoWorldAuthoritySchemaFields
} from "./authority.js";
import { createCheckedWorldSurfaceRegistry } from "./invoke.js";
import { parseBoundedJsonSchema } from "./schema.js";
import { parseWorldSurfaceSynchronousFunction } from "./synchrony.js";
import {
  WORLD_SURFACE_API_VERSION,
  type BoundedObjectJsonSchema,
  type CheckedWorldAffordanceDefinition,
  type CheckedWorldEffectDefinition,
  type CheckedWorldEntityDefinition,
  type CheckedWorldSenseDefinition,
  type WorldAffordanceDefinition,
  type WorldSenseDefinition,
  type WorldSurfaceRegistry
} from "./types.js";

type PlainRecord = Record<string, unknown>;
const MECHANICS_ADDRESS = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_.-]*)+$/u;
const MECHANICS_NAME = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)*$/u;
const parsedRegistries = new WeakSet<WorldSurfaceRegistry>();

export interface CheckedWorldSurfaceCallbacks {
  readonly affordances: ReadonlyMap<string, {
    readonly available: WorldAffordanceDefinition["available"];
    readonly lower: WorldAffordanceDefinition["lower"];
    readonly projectResult?: WorldAffordanceDefinition["project_result"];
  }>;
  readonly senses: ReadonlyMap<string, WorldSenseDefinition["project"]>;
}

export interface CheckedWorldSurfaceInput {
  readonly affordances: readonly CheckedWorldAffordanceDefinition[];
  readonly callbacks: CheckedWorldSurfaceCallbacks;
  readonly effects: readonly CheckedWorldEffectDefinition[];
  readonly entities: readonly CheckedWorldEntityDefinition[];
  readonly senses: readonly CheckedWorldSenseDefinition[];
}

const plainRecord = (value: unknown, path: string): PlainRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data value`);
    }
  }
  return value as PlainRecord;
};

const exactRecord = (
  value: unknown,
  fields: readonly string[],
  path: string
): PlainRecord => {
  const record = plainRecord(value, path);
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown field ${key}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`${path}.${field} is required`);
  }
  return record;
};

const optionalExactRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string
): PlainRecord => {
  const record = plainRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown field ${key}`);
  }
  for (const field of required) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`${path}.${field} is required`);
  }
  return record;
};

const definitionEntries = (value: unknown, path: string): [string, unknown][] => {
  const entries = Object.entries(plainRecord(value, path))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length > DYNAMICS_LIMITS.sense_grants) {
    throw new TypeError(`${path} exceeds the world-surface declaration limit`);
  }
  return entries;
};

const boundedString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0
    || value.length > DYNAMICS_LIMITS.identifier_code_units) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }
  return value;
};

const localReference = (
  value: unknown,
  kind: WorldResourceKind,
  path: string
): LocalResourceReference => {
  const input = boundedString(value, path);
  let parsed: LocalResourceReference;
  try {
    parsed = parseLocalResourceReference(input);
  } catch (error) {
    throw new TypeError(`${path} must be a valid local ${kind} reference`, { cause: error });
  }
  if (!parsed.startsWith(`${kind}:`)) {
    throw new TypeError(`${path} must use the ${kind}: reference kind`);
  }
  return parsed;
};

const mechanicsString = (
  value: unknown,
  path: string,
  pattern: RegExp
): string => {
  const parsed = boundedString(value, path);
  if (!pattern.test(parsed)) throw new TypeError(`${path} is not canonical`);
  return parsed;
};

const mechanicsAddress = (
  value: unknown,
  kind: "object" | "sense",
  path: string
): string => {
  const parsed = mechanicsString(value, path, MECHANICS_ADDRESS);
  if (!parsed.startsWith(`${kind}:`)) {
    throw new TypeError(`${path} must use the ${kind}: mechanics kind`);
  }
  return parsed;
};

const stringList = (
  value: unknown,
  path: string,
  pattern: RegExp,
  allowEmpty: boolean
): readonly string[] => {
  const cloned = cloneDynamicsJson(value, path);
  if (!Array.isArray(cloned)
    || (!allowEmpty && cloned.length === 0)
    || cloned.length > DYNAMICS_LIMITS.sense_grants) {
    throw new TypeError(`${path} must be a bounded${allowEmpty ? "" : " non-empty"} array`);
  }
  const parsed = cloned.map((entry, index) =>
    mechanicsString(entry, `${path}[${index}]`, pattern));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${path} must be unique`);
  return Object.freeze(parsed);
};

const objectSchema = (value: unknown, path: string): BoundedObjectJsonSchema => {
  const schema = parseBoundedJsonSchema(value);
  if (schema.type !== "object") throw new TypeError(`${path} must declare an object schema`);
  return schema;
};

const publicObjectSchema = (
  value: unknown,
  path: string,
  assertAuthority: (schema: BoundedObjectJsonSchema, path: string) => void =
    assertNoWorldAuthoritySchemaFields
): BoundedObjectJsonSchema => {
  const schema = objectSchema(value, path);
  assertAuthority(schema, path);
  return schema;
};

const parseEntities = (
  value: unknown
): readonly CheckedWorldEntityDefinition[] => {
  const parsed: CheckedWorldEntityDefinition[] = [];
  const addresses = new Set<string>();
  const mechanicsAddresses = new Set<string>();
  for (const [alias, input] of definitionEntries(value, "world surface.entities")) {
    localReference(`entity:${alias}`, "entity", `world surface.entities alias ${alias}`);
    const record = exactRecord(
      input,
      ["address", "dynamics_address"],
      `world surface.entities.${alias}`
    );
    const address = localReference(
      record.address,
      "entity",
      `world surface.entities.${alias}.address`
    );
    if (address !== `entity:${alias}`) {
      throw new TypeError(`world surface.entities.${alias}.address must equal entity:${alias}`);
    }
    const dynamicsAddress = mechanicsAddress(
      record.dynamics_address,
      "object",
      `world surface.entities.${alias}.dynamics_address`,
    );
    if (addresses.has(address)) throw new TypeError(`duplicate entity address ${address}`);
    if (mechanicsAddresses.has(dynamicsAddress)) {
      throw new TypeError(`duplicate mechanics entity address ${dynamicsAddress}`);
    }
    addresses.add(address);
    mechanicsAddresses.add(dynamicsAddress);
    parsed.push(Object.freeze({ address, alias, dynamics_address: dynamicsAddress }));
  }
  return Object.freeze(parsed);
};

const parseSenses = (
  value: unknown,
  callbacks: Map<string, WorldSenseDefinition["project"]>
): readonly CheckedWorldSenseDefinition[] => Object.freeze(
  definitionEntries(value, "world surface.senses").map(([key, input]) => {
    const address = localReference(key, "sense", `world surface.senses key ${key}`);
    const record = exactRecord(
      input,
      ["dynamics_senses", "output", "project"],
      `world surface.senses.${key}`
    );
    if (record.output !== "simfile.numeric-observation.v1") {
      throw new TypeError(`world surface.senses.${key}.output is unsupported`);
    }
    callbacks.set(address, parseWorldSurfaceSynchronousFunction(
      record.project,
      `world surface.senses.${key}.project`
    ));
    return Object.freeze({
      address,
      dynamics_senses: Object.freeze(stringList(
        record.dynamics_senses,
        `world surface.senses.${key}.dynamics_senses`,
        MECHANICS_ADDRESS,
        false
      ).map((sense, index) =>
        mechanicsAddress(
          sense,
          "sense",
          `world surface.senses.${key}.dynamics_senses[${index}]`
        ))),
      output: "simfile.numeric-observation.v1" as const
    });
  })
);

const parseTargetSelector = (
  value: unknown,
  path: string,
  declaredEntities: ReadonlySet<string>
): CheckedWorldAffordanceDefinition["target_selector"] => {
  const record = plainRecord(value, path);
  if (!Object.hasOwn(record, "kind")) throw new TypeError(`${path}.kind is required`);
  const kind = record.kind;
  if (kind === "holder") {
    exactRecord(value, ["kind"], path);
    return Object.freeze({ kind: "holder" });
  }
  if (kind !== "fixed") throw new TypeError(`${path}.kind is unsupported`);
  const fixed = exactRecord(value, ["kind", "targets"], path);
  const cloned = cloneDynamicsJson(fixed.targets, `${path}.targets`);
  if (!Array.isArray(cloned) || cloned.length === 0
    || cloned.length > DYNAMICS_LIMITS.sense_grants) {
    throw new TypeError(`${path}.targets must be a bounded non-empty array`);
  }
  const targets = cloned.map((target, index) =>
    localReference(target, "entity", `${path}.targets[${index}]`));
  if (new Set(targets).size !== targets.length) throw new TypeError(`${path}.targets must be unique`);
  for (const target of targets) {
    if (!declaredEntities.has(target)) throw new TypeError(`${path} names undeclared target ${target}`);
  }
  return Object.freeze({ kind: "fixed", targets: Object.freeze(targets) });
};

const parseAffordances = (
  value: unknown,
  declaredEntities: ReadonlySet<string>,
  callbacks: Map<string, {
    available: WorldAffordanceDefinition["available"];
    lower: WorldAffordanceDefinition["lower"];
    projectResult?: WorldAffordanceDefinition["project_result"];
  }>
): readonly CheckedWorldAffordanceDefinition[] => Object.freeze(
  definitionEntries(value, "world surface.affordances").map(([key, input]) => {
    const address = localReference(key, "affordance", `world surface.affordances key ${key}`);
    const path = `world surface.affordances.${key}`;
    const record = optionalExactRecord(input, [
      "available", "dynamics_action", "input_schema", "lower",
      "rejection_codes", "target_selector"
    ], ["project_result"], path);
    const projectResult = Object.hasOwn(record, "project_result")
      ? record.project_result
      : undefined;
    const callback = {
      available: parseWorldSurfaceSynchronousFunction<WorldAffordanceDefinition["available"]>(
        record.available, `${path}.available`
      ),
      lower: parseWorldSurfaceSynchronousFunction<WorldAffordanceDefinition["lower"]>(
        record.lower, `${path}.lower`
      ),
      ...(projectResult === undefined ? {} : {
        projectResult: parseWorldSurfaceSynchronousFunction<
          NonNullable<WorldAffordanceDefinition["project_result"]>
        >(projectResult, `${path}.project_result`)
      })
    };
    callbacks.set(address, Object.freeze(callback));
    return Object.freeze({
      address,
      dynamics_action: mechanicsString(record.dynamics_action, `${path}.dynamics_action`, MECHANICS_NAME),
      input_schema: publicObjectSchema(
        record.input_schema,
        `${path}.input_schema`,
        assertNoWorldActionSchemaAuthorityFields
      ),
      rejection_codes: stringList(record.rejection_codes, `${path}.rejection_codes`, MECHANICS_NAME, true),
      target_selector: parseTargetSelector(record.target_selector, `${path}.target_selector`, declaredEntities)
    });
  })
);

const parseEffects = (value: unknown): readonly CheckedWorldEffectDefinition[] => {
  const events = new Set<string>();
  return Object.freeze(definitionEntries(value, "world surface.effects").map(([key, input]) => {
    const address = localReference(key, "effect", `world surface.effects key ${key}`);
    const path = `world surface.effects.${key}`;
    const record = exactRecord(input, ["dynamics_event", "payload_schema"], path);
    const dynamicsEvent = mechanicsString(record.dynamics_event, `${path}.dynamics_event`, MECHANICS_NAME);
    if (events.has(dynamicsEvent)) throw new TypeError(`duplicate mechanics event ${dynamicsEvent}`);
    events.add(dynamicsEvent);
    return Object.freeze({
      address,
      dynamics_event: dynamicsEvent,
      payload_schema: publicObjectSchema(record.payload_schema, `${path}.payload_schema`)
    });
  }));
};

export const parseWorldSurfaceDefinition = (input: unknown): WorldSurfaceRegistry => {
  const record = exactRecord(
    input,
    ["affordances", "api_version", "effects", "entities", "senses"],
    "world surface"
  );
  if (record.api_version !== WORLD_SURFACE_API_VERSION) {
    throw new TypeError(`world surface.api_version must be ${WORLD_SURFACE_API_VERSION}`);
  }
  const senseCallbacks = new Map<string, WorldSenseDefinition["project"]>();
  const affordanceCallbacks = new Map<string, {
    available: WorldAffordanceDefinition["available"];
    lower: WorldAffordanceDefinition["lower"];
    projectResult?: WorldAffordanceDefinition["project_result"];
  }>();
  const entities = parseEntities(record.entities);
  const checked: CheckedWorldSurfaceInput = {
    affordances: parseAffordances(
      record.affordances,
      new Set(entities.map((entity) => entity.address)),
      affordanceCallbacks
    ),
    callbacks: { affordances: affordanceCallbacks, senses: senseCallbacks },
    effects: parseEffects(record.effects),
    entities,
    senses: parseSenses(record.senses, senseCallbacks)
  };
  const registry = createCheckedWorldSurfaceRegistry(checked);
  parsedRegistries.add(registry);
  return registry;
};

/** Returns a registry only when this parser issued that exact checked object. */
export const readParsedWorldSurfaceRegistry = (
  input: unknown
): WorldSurfaceRegistry | undefined => parsedRegistries.has(input as WorldSurfaceRegistry)
  ? input as WorldSurfaceRegistry
  : undefined;
