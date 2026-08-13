import { types } from "node:util";

import type { WorldControllerAction } from "../world/controllerAuthority.js";
import { DYNAMICS_LIMITS } from "./limits.js";
import type {
  DynamicsActionQueueReceipt,
  ReadonlyDynamicsJsonObject
} from "./types.js";
import type { WorldActIngressReceipt } from "../world/actTypes.js";

export const DYNAMICS_RUN_ACTION_SOURCE_VERSION =
  "simfile.dynamics-run-action-source.v1" as const;

export const DYNAMICS_RUN_ACTION_SOURCE_PROVENANCES = [
  "scripted",
  "model"
] as const;
export type DynamicsRunActionSourceProvenance =
  typeof DYNAMICS_RUN_ACTION_SOURCE_PROVENANCES[number];

export interface DynamicsRunActionSourceInitialization {
  readonly config: ReadonlyDynamicsJsonObject;
  readonly seed: string;
  readonly sim_seconds_per_tick: number;
}

export type DynamicsRunControllerAction = WorldControllerAction;
export interface DynamicsRunWorldActRequest {
  readonly affordance: string;
  readonly target: string;
  readonly input: unknown;
}

export interface DynamicsRunActionSourceTick {
  readonly next_tick: number;
  readonly sim_time: number;
  observe(participant: string, request: unknown): unknown;
  act?(
    participant: string,
    request: DynamicsRunWorldActRequest
  ): WorldActIngressReceipt;
  queueController(
    action: DynamicsRunControllerAction
  ): DynamicsActionQueueReceipt;
}

export interface DynamicsRunActionSourceDeclaration {
  readonly id: string;
  readonly live_acceptance: boolean;
  readonly participants: readonly string[];
  readonly provenance: DynamicsRunActionSourceProvenance;
  readonly version: typeof DYNAMICS_RUN_ACTION_SOURCE_VERSION;
  onTick(context: DynamicsRunActionSourceTick): void | PromiseLike<void>;
}

export type DynamicsRunActionSourceFactory = (
  initialization: DynamicsRunActionSourceInitialization
) => DynamicsRunActionSourceDeclaration | undefined;

const DECLARATION_KEYS = [
  "id",
  "live_acceptance",
  "onTick",
  "participants",
  "provenance",
  "version"
] as const;

const codePointOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ordinaryDataObject = (
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> => {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an ordinary object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} must contain exactly ${expectedKeys.join(", ")}`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${String(key)} must be an enumerable data value`);
    }
  }
  return value as Record<string, unknown>;
};

const identifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  if (value.length > DYNAMICS_LIMITS.identifier_code_units) {
    throw new Error(`${label} exceeds the dynamics identifier code-unit limit`);
  }
  return value;
};

const participantList = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0
  ) {
    throw new Error(
      "dynamics run action source participants must be a non-empty ordinary array"
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new Error(
      "dynamics run action source participants must be a dense data array"
    );
  }
  const participants: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(
        "dynamics run action source participants must be a dense data array"
      );
    }
    participants.push(identifier(
      descriptor.value,
      `dynamics run action source participants[${index}]`
    ));
  }
  if (new Set(participants).size !== participants.length) {
    throw new Error("dynamics run action source participants must be unique");
  }
  const sorted = [...participants].sort(codePointOrder);
  if (participants.some((participant, index) => participant !== sorted[index])) {
    throw new Error(
      "dynamics run action source participants must be in code-point order"
    );
  }
  return Object.freeze(participants);
};

export const parseDynamicsRunActionSourceDeclaration = (
  value: unknown,
  declaredParticipants: ReadonlySet<string>
): DynamicsRunActionSourceDeclaration => {
  const source = ordinaryDataObject(
    value,
    DECLARATION_KEYS,
    "dynamics run action source"
  );
  if (source.version !== DYNAMICS_RUN_ACTION_SOURCE_VERSION) {
    throw new Error(
      `dynamics run action source version must be ${DYNAMICS_RUN_ACTION_SOURCE_VERSION}`
    );
  }
  if (!DYNAMICS_RUN_ACTION_SOURCE_PROVENANCES.includes(
    source.provenance as DynamicsRunActionSourceProvenance
  )) {
    throw new Error("dynamics run action source provenance is unsupported");
  }
  if (source.live_acceptance !== false) {
    throw new Error("dynamics run action source live_acceptance must be false");
  }
  if (typeof source.onTick !== "function") {
    throw new Error("dynamics run action source onTick must be a function");
  }
  const participants = participantList(source.participants);
  for (const participant of participants) {
    if (!declaredParticipants.has(participant)) {
      throw new Error(
        `dynamics run action source participant ${participant} is not declared in world.grants`
      );
    }
  }
  return Object.freeze({
    id: identifier(source.id, "dynamics run action source id"),
    live_acceptance: false,
    onTick: source.onTick as DynamicsRunActionSourceDeclaration["onTick"],
    participants,
    provenance: source.provenance as DynamicsRunActionSourceProvenance,
    version: DYNAMICS_RUN_ACTION_SOURCE_VERSION
  });
};
