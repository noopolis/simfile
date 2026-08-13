import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import type {
  ReadonlyDynamicsJsonObject,
  ReadonlyDynamicsJsonValue
} from "../dynamics/types.js";
import {
  parseLocalResourceReference,
  type LocalResourceReference,
  type WorldResourceKind
} from "../world/addresses.js";
import type {
  CheckedWorldSurfaceCallbacks,
  CheckedWorldSurfaceInput
} from "./definition.js";
import { assertNoWorldAuthorityFields } from "./authority.js";
import { parseWorldSurfaceObservation } from "./observation.js";
import {
  cloneStableDynamicsJsonObject,
  deepFreezeOwnData,
  nullPrototypeRecord
} from "./own-data.js";
import { parseBoundedJsonValue } from "./schema.js";
import { WorldSurfaceActionInputRejection } from "./rejection.js";
import { callWorldSurfaceSynchronous } from "./synchrony.js";
import {
  WORLD_SURFACE_API_VERSION,
  type CheckedWorldAffordanceDefinition,
  type CheckedWorldEffectDefinition,
  type CheckedWorldEntityDefinition,
  type CheckedWorldSenseDefinition,
  type ReadonlyWorldSurfaceObservation,
  type WorldAffordanceContext,
  type WorldAffordanceLoweringInput,
  type WorldMechanicsResult,
  type WorldProjectedEffect,
  type WorldSenseProjectionInput,
  type WorldSurfaceRegistry
} from "./types.js";

type PlainRecord = Record<string, unknown>;
const MECHANICS_NAME = /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)*$/u;

const ownInput = (
  value: unknown,
  required: readonly string[],
  path: string,
  optional: readonly string[] = []
): PlainRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains unknown field ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data value`);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${path}.${field} is required`);
  }
  return value as PlainRecord;
};

const boundedString = (value: unknown, path: string, limit: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }
  return value;
};

const canonicalString = (
  value: unknown,
  path: string,
  pattern: RegExp
): string => {
  const parsed = boundedString(value, path, DYNAMICS_LIMITS.identifier_code_units);
  if (!pattern.test(parsed)) throw new TypeError(`${path} is not canonical`);
  return parsed;
};

const localReference = (
  value: unknown,
  kind: WorldResourceKind,
  path: string
): LocalResourceReference => {
  const input = boundedString(value, path, DYNAMICS_LIMITS.identifier_code_units);
  let reference: LocalResourceReference;
  try {
    reference = parseLocalResourceReference(input);
  } catch (error) {
    throw new TypeError(`${path} must be a valid local ${kind} reference`, { cause: error });
  }
  if (!reference.startsWith(`${kind}:`)) throw new TypeError(`${path} must use ${kind}:`);
  return reference;
};

const parseMechanicsResult = (
  value: unknown,
  codes: ReadonlySet<string>
): WorldMechanicsResult => {
  const record = ownInput(
    value,
    ["accepted"],
    "world mechanics result",
    ["code", "message"]
  );
  if (typeof record.accepted !== "boolean") {
    throw new TypeError("world mechanics result.accepted must be boolean");
  }
  const rawCode = Object.hasOwn(record, "code") ? record.code : undefined;
  const code = rawCode === undefined ? undefined
    : canonicalString(rawCode, "world mechanics result.code", MECHANICS_NAME);
  if (record.accepted && code !== undefined) {
    throw new TypeError("accepted world mechanics result must not declare code");
  }
  if (!record.accepted && (code === undefined || !codes.has(code))) {
    throw new TypeError("world mechanics result uses an undeclared rejection code");
  }
  const rawMessage = Object.hasOwn(record, "message") ? record.message : undefined;
  const message = rawMessage === undefined ? undefined
    : boundedString(
      rawMessage,
      "world mechanics result.message",
      DYNAMICS_LIMITS.message_code_units
    );
  const entries: Array<readonly [string, boolean | string]> = [
    ["accepted", record.accepted]
  ];
  if (code !== undefined) entries.push(["code", code]);
  if (message !== undefined) entries.push(["message", message]);
  return Object.freeze(
    nullPrototypeRecord(entries)
  ) as unknown as WorldMechanicsResult;
};

class CheckedRegistry implements WorldSurfaceRegistry {
  readonly affordances: readonly CheckedWorldAffordanceDefinition[];
  readonly api_version = WORLD_SURFACE_API_VERSION;
  readonly effects: readonly CheckedWorldEffectDefinition[];
  readonly entities: readonly CheckedWorldEntityDefinition[];
  readonly senses: readonly CheckedWorldSenseDefinition[];
  readonly #affordanceCallbacks: CheckedWorldSurfaceCallbacks["affordances"];
  readonly #affordanceByAddress: ReadonlyMap<string, CheckedWorldAffordanceDefinition>;
  readonly #effectByEvent: ReadonlyMap<string, CheckedWorldEffectDefinition>;
  readonly #entityAddresses: ReadonlySet<string>;
  readonly #senseCallbacks: CheckedWorldSurfaceCallbacks["senses"];
  readonly #senseByAddress: ReadonlyMap<string, CheckedWorldSenseDefinition>;

  constructor(input: CheckedWorldSurfaceInput) {
    this.affordances = input.affordances;
    this.effects = input.effects;
    this.entities = input.entities;
    this.senses = input.senses;
    this.#affordanceCallbacks = new Map(input.callbacks.affordances);
    this.#affordanceByAddress = new Map(input.affordances.map((entry) => [entry.address, entry]));
    this.#effectByEvent = new Map(input.effects.map((entry) => [entry.dynamics_event, entry]));
    this.#entityAddresses = new Set(input.entities.map((entry) => entry.address));
    this.#senseCallbacks = new Map(input.callbacks.senses);
    this.#senseByAddress = new Map(input.senses.map((entry) => [entry.address, entry]));
    Object.freeze(this);
  }

  projectSense(
    senseInput: LocalResourceReference,
    input: WorldSenseProjectionInput
  ): ReadonlyWorldSurfaceObservation {
    const sense = localReference(senseInput, "sense", "world sense");
    if (!this.#senseByAddress.has(sense)) throw new TypeError(`undeclared world sense ${sense}`);
    const record = ownInput(input, ["holder", "observation"], "world sense projection input");
    const holder = this.#declaredEntity(record.holder, "world sense projection input.holder");
    const observation = parseWorldSurfaceObservation(
      record.observation,
      "world sense projection input.observation"
    );
    const senseDefinition = this.#senseByAddress.get(sense)!;
    for (const channel of observation.channels) {
      if (!senseDefinition.dynamics_senses.includes(channel.sense_address)) {
        throw new TypeError(
          "world sense projection input contains an undeclared mechanics sense"
        );
      }
    }
    const callbackInput = Object.freeze(nullPrototypeRecord<
      LocalResourceReference | ReadonlyWorldSurfaceObservation
    >([
      ["holder", holder],
      ["observation", observation]
    ])) as unknown as WorldSenseProjectionInput;
    const output = callWorldSurfaceSynchronous(
      this.#senseCallbacks.get(sense)! as (...args: never[]) => unknown,
      callbackInput,
      `world sense ${sense}.project`
    );
    const projected = this.#publicObservation(
      output,
      `world sense ${sense}.project output`,
      sense
    );
    return projected;
  }

  isAffordanceAvailable(
    affordanceInput: LocalResourceReference,
    input: WorldAffordanceContext
  ): boolean {
    const [affordance, callback, callbackInput] =
      this.#affordanceInvocation(affordanceInput, input, false);
    const output = callWorldSurfaceSynchronous(
      callback.available as (...args: never[]) => unknown,
      callbackInput,
      `world affordance ${affordance.address}.available`
    );
    if (typeof output !== "boolean") throw new TypeError("world affordance.available must return boolean");
    return output;
  }

  lowerAffordance(
    affordanceInput: LocalResourceReference,
    input: WorldAffordanceLoweringInput
  ): ReadonlyDynamicsJsonObject {
    const [affordance, callback, context] =
      this.#affordanceInvocation(affordanceInput, input, true);
    const record = ownInput(input, ["holder", "input", "observation", "target"], "world lowering input");
    const publicInput = parseBoundedJsonValue(affordance.input_schema, record.input, "world action input");
    if (publicInput === null || Array.isArray(publicInput) || typeof publicInput !== "object") {
      throw new WorldSurfaceActionInputRejection(
        "world action input must be an object",
        "action_input_malformed",
      );
    }
    const callbackInput = Object.freeze(nullPrototypeRecord<
      LocalResourceReference | ReadonlyDynamicsJsonValue | ReadonlyWorldSurfaceObservation
    >([
      ["holder", context.holder],
      ["input", publicInput],
      ["observation", context.observation],
      ["target", context.target]
    ])) as unknown as WorldAffordanceLoweringInput;
    const output = callWorldSurfaceSynchronous(
      callback.lower as (...args: never[]) => unknown,
      callbackInput,
      `world affordance ${affordance.address}.lower`
    );
    const mechanicsInput = deepFreezeOwnData(
      cloneStableDynamicsJsonObject(output, "world lowered mechanics input")
    );
    assertNoWorldAuthorityFields(mechanicsInput, "world lowered mechanics input");
    return mechanicsInput;
  }

  projectAffordanceResult(
    affordanceInput: LocalResourceReference,
    result: WorldMechanicsResult
  ): ReadonlyDynamicsJsonObject | undefined {
    const affordance = this.#declaredAffordance(affordanceInput);
    const callback = this.#affordanceCallbacks.get(affordance.address)!;
    const checked = parseMechanicsResult(result, new Set(affordance.rejection_codes));
    if (!callback.projectResult) return undefined;
    const output = callWorldSurfaceSynchronous(
      callback.projectResult as (...args: never[]) => unknown,
      checked,
      `world affordance ${affordance.address}.project_result`
    );
    const projected = deepFreezeOwnData(
      cloneStableDynamicsJsonObject(output, "world projected action result")
    );
    assertNoWorldAuthorityFields(projected, "world projected action result");
    return projected;
  }

  projectEffect(dynamicsEventInput: string, payload: unknown): WorldProjectedEffect {
    const dynamicsEvent = canonicalString(
      dynamicsEventInput,
      "world mechanics event",
      MECHANICS_NAME
    );
    const effect = this.#effectByEvent.get(dynamicsEvent);
    if (!effect) throw new TypeError(`undeclared world mechanics event ${dynamicsEvent}`);
    const checked = parseBoundedJsonValue(effect.payload_schema, payload, "world effect payload");
    if (checked === null || Array.isArray(checked) || typeof checked !== "object") {
      throw new TypeError("world effect payload must be an object");
    }
    return Object.freeze(nullPrototypeRecord<
      LocalResourceReference | ReadonlyDynamicsJsonObject
    >([
      ["effect", effect.address],
      ["payload", checked as ReadonlyDynamicsJsonObject]
    ])) as unknown as WorldProjectedEffect;
  }

  #declaredEntity(value: unknown, path: string): LocalResourceReference {
    const entity = localReference(value, "entity", path);
    if (!this.#entityAddresses.has(entity)) throw new TypeError(`${path} is undeclared`);
    return entity;
  }

  #declaredAffordance(value: unknown): CheckedWorldAffordanceDefinition {
    const address = localReference(value, "affordance", "world affordance");
    const affordance = this.#affordanceByAddress.get(address);
    if (!affordance) throw new TypeError(`undeclared world affordance ${address}`);
    return affordance;
  }

  #publicObservation(
    value: unknown,
    path: string,
    expectedSense?: LocalResourceReference
  ): ReadonlyWorldSurfaceObservation {
    const observation = parseWorldSurfaceObservation(value, path);
    assertNoWorldAuthorityFields(
      observation as unknown as ReadonlyDynamicsJsonValue,
      path
    );
    for (const channel of observation.channels) {
      const sense = localReference(channel.sense_address, "sense", `${path}.sense_address`);
      if (!this.#senseByAddress.has(sense) || (expectedSense && sense !== expectedSense)) {
        throw new TypeError(`${path} uses an undeclared or different public sense`);
      }
      this.#declaredEntity(channel.subject_address, `${path}.subject_address`);
    }
    return observation;
  }

  #affordanceInvocation(
    affordanceInput: LocalResourceReference,
    input: WorldAffordanceContext | WorldAffordanceLoweringInput,
    lowering: boolean
  ): [
    CheckedWorldAffordanceDefinition,
    CheckedWorldSurfaceCallbacks["affordances"] extends ReadonlyMap<string, infer Value> ? Value : never,
    Readonly<WorldAffordanceContext>
  ] {
    const affordance = this.#declaredAffordance(affordanceInput);
    const fields = lowering
      ? ["holder", "input", "observation", "target"]
      : ["holder", "observation", "target"];
    const record = ownInput(input, fields, "world affordance input");
    const holder = this.#declaredEntity(record.holder, "world affordance input.holder");
    const target = this.#declaredEntity(record.target, "world affordance input.target");
    if ((affordance.target_selector.kind === "holder" && target !== holder)
      || (affordance.target_selector.kind === "fixed"
        && !affordance.target_selector.targets.includes(target))) {
      throw new TypeError("world affordance target is outside its declared selector");
    }
    const context = Object.freeze(nullPrototypeRecord<
      LocalResourceReference | ReadonlyWorldSurfaceObservation
    >([
      ["holder", holder],
      ["observation", this.#publicObservation(
        record.observation,
        "world affordance input.observation"
      )],
      ["target", target]
    ])) as unknown as Readonly<WorldAffordanceContext>;
    return [affordance, this.#affordanceCallbacks.get(affordance.address)!, context];
  }
}

export const createCheckedWorldSurfaceRegistry = (
  input: CheckedWorldSurfaceInput
): WorldSurfaceRegistry => new CheckedRegistry(input);
