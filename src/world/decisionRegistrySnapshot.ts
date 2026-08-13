import { types as nodeTypes } from "node:util";
import type {
  DecisionAdmission,
  DecisionPhase,
  DecisionRegistryInspection,
  DecisionStatus,
} from "./decisionRegistry.js";

export const DECISION_REGISTRY_SNAPSHOT_VERSION = "simfile.decision-registry.v1" as const;

export interface DecisionRegistrySnapshotDecision {
  readonly decisionId: string;
  readonly principal: string;
  readonly status: DecisionStatus;
  readonly issuedTick: number;
  readonly validThroughTick: number;
  readonly tokenDigest: string;
}

export interface DecisionRegistrySnapshot {
  readonly version: typeof DECISION_REGISTRY_SNAPSHOT_VERSION;
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly tokenDigestKeyFingerprint: string;
  readonly phase: DecisionPhase;
  readonly cutoffTick: number | null;
  readonly admissionsClosedTick: number | null;
  readonly finalizedTick: number | null;
  readonly lastTick: number | null;
  readonly nextDecisionSequence: number;
  readonly decisions: readonly DecisionRegistrySnapshotDecision[];
}

export interface ParsedDecisionRegistrySnapshot {
  readonly phase: DecisionPhase;
  readonly cutoffTick: number | null;
  readonly admissionsClosedTick: number | null;
  readonly finalizedTick: number | null;
  readonly lastTick: number | null;
  readonly nextDecisionSequence: number;
  readonly decisions: readonly DecisionRegistrySnapshotDecision[];
}

interface SnapshotIdentity {
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly tokenDigestKeyFingerprint: string;
}

export interface DecisionRegistrySnapshotState {
  readonly phase: DecisionPhase;
  readonly cutoffTick: number | null;
  readonly admissionsClosedTick: number | null;
  readonly finalizedTick: number | null;
  readonly lastTick: number | null;
  readonly nextDecisionSequence: number;
}

export interface DecisionRegistryTestingOptions {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly maxDecisionSequence?: number;
}

const SNAPSHOT_KEYS = [
  "version", "runId", "worldInstanceId", "tokenDigestKeyFingerprint", "phase", "cutoffTick",
  "admissionsClosedTick", "finalizedTick", "lastTick", "nextDecisionSequence", "decisions",
];
const DECISION_KEYS = ["decisionId", "principal", "status", "issuedTick", "validThroughTick", "tokenDigest"];
const ID_PATTERN = /^decision-\d{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_SEQUENCE = 999_999_999_999;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const UINT8_SET = Uint8Array.prototype.set;

/** Pure parser: it owns no registry state, token material, or configured key. */
export const parseDecisionRegistrySnapshot = (
  input: unknown,
  identity: SnapshotIdentity,
): ParsedDecisionRegistrySnapshot | undefined => {
  const value = exactObject(input, SNAPSHOT_KEYS);
  if (!hasMatchingIdentity(value, identity) || !hasSnapshotScalars(value)) return undefined;
  const candidates = exactArray(value.decisions);
  if (candidates === undefined) return undefined;
  const decisions = parseDecisions(candidates);
  if (decisions === undefined || value.nextDecisionSequence !== decisions.length + 1) return undefined;
  if (!isLifecycleConsistent(value, decisions)) return undefined;
  return {
    phase: value.phase as DecisionPhase,
    cutoffTick: value.cutoffTick as number | null,
    admissionsClosedTick: value.admissionsClosedTick as number | null,
    finalizedTick: value.finalizedTick as number | null,
    lastTick: value.lastTick as number | null,
    nextDecisionSequence: value.nextDecisionSequence,
    decisions,
  };
};

export const cloneAndFreezeDecisionRegistrySnapshot = (
  snapshot: DecisionRegistrySnapshot,
): DecisionRegistrySnapshot => {
  const decisions = snapshot.decisions.map((decision) => Object.freeze({ ...decision }));
  return Object.freeze({ ...snapshot, decisions: Object.freeze(decisions) });
};

export const createDecisionRegistrySnapshot = (
  runId: string,
  worldInstanceId: string,
  tokenDigestKeyFingerprint: string,
  state: DecisionRegistrySnapshotState,
  decisions: readonly DecisionAdmission[],
): DecisionRegistrySnapshot => cloneAndFreezeDecisionRegistrySnapshot({
  version: DECISION_REGISTRY_SNAPSHOT_VERSION,
  runId,
  worldInstanceId,
  tokenDigestKeyFingerprint,
  phase: state.phase,
  cutoffTick: state.cutoffTick,
  admissionsClosedTick: state.admissionsClosedTick,
  finalizedTick: state.finalizedTick,
  lastTick: state.lastTick,
  nextDecisionSequence: state.nextDecisionSequence,
  decisions: decisions.map(toSnapshotDecision),
});

export const createDecisionRegistryInspection = (
  state: DecisionRegistrySnapshotState,
  decisions: readonly DecisionAdmission[],
): DecisionRegistryInspection => Object.freeze({
  phase: state.phase,
  cutoffTick: state.cutoffTick,
  admissionsClosedTick: state.admissionsClosedTick,
  finalizedTick: state.finalizedTick,
  lastTick: state.lastTick,
  nextDecisionSequence: state.nextDecisionSequence,
  decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
});

/** Copies a native Uint8Array/Buffer without consulting caller-controlled properties. */
export const copySafeUint8Array = (input: unknown): Uint8Array | undefined => {
  if (nodeTypes.isProxy(input) || !nodeTypes.isUint8Array(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype || BYTE_LENGTH_GETTER === undefined) {
    return undefined;
  }
  try {
    const copy = new Uint8Array(BYTE_LENGTH_GETTER.call(input) as number);
    UINT8_SET.call(copy, input);
    return copy;
  } catch {
    return undefined;
  }
};

/** Reads enumerable data properties from a non-proxy plain object without invoking accessors. */
export const readDataObject = (
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined => {
  if (nodeTypes.isProxy(input) || typeof input !== "object" || input === null ||
    Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) {
      if (required.includes(key)) return undefined;
      continue;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
};

export const parseDecisionRegistryTestingOptions = (
  input: unknown,
  maximumSequence: number,
): DecisionRegistryTestingOptions | undefined => {
  const value = readDataObject(input, ["randomBytes"], ["maxDecisionSequence"]);
  if (value === undefined || typeof value.randomBytes !== "function" ||
    (value.maxDecisionSequence !== undefined &&
      (!isDecisionRegistryTick(value.maxDecisionSequence) || value.maxDecisionSequence < 1 ||
        value.maxDecisionSequence > maximumSequence))) {
    return undefined;
  }
  return {
    randomBytes: value.randomBytes as (size: number) => Uint8Array,
    maxDecisionSequence: value.maxDecisionSequence as number | undefined,
  };
};

const hasMatchingIdentity = (
  value: Record<string, unknown> | undefined,
  identity: SnapshotIdentity,
): value is Record<string, unknown> => value !== undefined &&
  value.version === DECISION_REGISTRY_SNAPSHOT_VERSION && value.runId === identity.runId &&
  value.worldInstanceId === identity.worldInstanceId &&
  value.tokenDigestKeyFingerprint === identity.tokenDigestKeyFingerprint;

const hasSnapshotScalars = (value: Record<string, unknown>): boolean =>
  isPhase(value.phase) && isNullableTick(value.cutoffTick) &&
  isNullableTick(value.admissionsClosedTick) && isNullableTick(value.finalizedTick) &&
  isNullableTick(value.lastTick) && isSequence(value.nextDecisionSequence);

const parseDecisions = (
  candidates: readonly unknown[],
): DecisionRegistrySnapshotDecision[] | undefined => {
  const decisions: DecisionRegistrySnapshotDecision[] = [];
  const digests = new Set<string>();
  const previousByPrincipal = new Map<string, DecisionRegistrySnapshotDecision>();
  let previousIssuedTick = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const decision = parseDecision(candidates[index], index + 1);
    if (decision === undefined || decision.issuedTick < previousIssuedTick || digests.has(decision.tokenDigest)) {
      return undefined;
    }
    const previous = previousByPrincipal.get(decision.principal);
    if (previous?.status === "active" ||
      (previous?.status === "expired" && decision.issuedTick <= previous.validThroughTick)) {
      return undefined;
    }
    previousIssuedTick = decision.issuedTick;
    previousByPrincipal.set(decision.principal, decision);
    digests.add(decision.tokenDigest);
    decisions.push(decision);
  }
  return decisions;
};

const parseDecision = (
  input: unknown,
  sequence: number,
): DecisionRegistrySnapshotDecision | undefined => {
  const value = exactObject(input, DECISION_KEYS);
  if (value === undefined || value.decisionId !== formatDecisionRegistryId(sequence) || !isDecisionRegistryBinding(value.principal) ||
    !isStatus(value.status) || !isDecisionRegistryTick(value.issuedTick) || !isDecisionRegistryTick(value.validThroughTick) ||
    value.validThroughTick < value.issuedTick || !isDigest(value.tokenDigest)) {
    return undefined;
  }
  return {
    decisionId: value.decisionId,
    principal: value.principal,
    status: value.status,
    issuedTick: value.issuedTick,
    validThroughTick: value.validThroughTick,
    tokenDigest: value.tokenDigest,
  };
};

const toSnapshotDecision = (decision: DecisionAdmission): DecisionRegistrySnapshotDecision => ({
  decisionId: decision.decisionId,
  principal: decision.principal,
  status: decision.status,
  issuedTick: decision.issuedTick,
  validThroughTick: decision.validThroughTick,
  tokenDigest: decision.tokenDigest,
});

const isLifecycleConsistent = (
  value: Record<string, unknown>,
  decisions: readonly DecisionRegistrySnapshotDecision[],
): boolean => {
  const phase = value.phase as DecisionPhase;
  const cutoffTick = value.cutoffTick as number | null;
  const admissionsClosedTick = value.admissionsClosedTick as number | null;
  const finalizedTick = value.finalizedTick as number | null;
  const lastTick = value.lastTick as number | null;
  if (!hasValidFrontiers(phase, cutoffTick, admissionsClosedTick, finalizedTick)) return false;
  if (lastTick === null) return decisions.length === 0 && phase === "open";
  if (decisions.length === 0 && phase === "open") return false;
  if (!isDecisionRegistryTick(lastTick) || hasFutureFrontier(lastTick, cutoffTick, admissionsClosedTick, finalizedTick)) return false;
  if (!hasReachableLastTick(phase, cutoffTick, admissionsClosedTick, finalizedTick, lastTick, decisions)) return false;
  return decisions.every((decision) =>
    isDecisionReachable(decision, phase, cutoffTick, admissionsClosedTick, lastTick));
};

const hasReachableLastTick = (
  phase: DecisionPhase,
  cutoffTick: number | null,
  admissionsClosedTick: number | null,
  finalizedTick: number | null,
  lastTick: number,
  decisions: readonly DecisionRegistrySnapshotDecision[],
): boolean => {
  if (phase === "admissions_closed") return lastTick === admissionsClosedTick;
  if (phase === "finalized") return lastTick === finalizedTick;
  if (phase === "cutoff" && lastTick === cutoffTick) return true;
  if (phase === "open" && decisions.some((decision) => decision.issuedTick === lastTick)) return true;
  const terminalByPrincipal = new Map<string, DecisionRegistrySnapshotDecision>();
  for (const decision of decisions) terminalByPrincipal.set(decision.principal, decision);
  const latestIssuedTick = decisions.at(-1)?.issuedTick ?? -1;
  return [...terminalByPrincipal.values()].some((decision) => {
    if ((decision.status === "active" || decision.status === "consumed")
      && lastTick <= decision.validThroughTick) return true;
    if (decision.status !== "expired" || lastTick <= decision.validThroughTick) return false;
    return phase === "cutoff"
      ? isDecisionRegistryTick(cutoffTick) && cutoffTick <= decision.validThroughTick
      : latestIssuedTick <= decision.validThroughTick;
  });
};

const hasValidFrontiers = (
  phase: unknown,
  cutoffTick: unknown,
  admissionsClosedTick: unknown,
  finalizedTick: unknown,
): boolean => phase === "open" ? cutoffTick === null && admissionsClosedTick === null && finalizedTick === null
  : phase === "cutoff" ? isDecisionRegistryTick(cutoffTick) && admissionsClosedTick === null && finalizedTick === null
    : phase === "admissions_closed" ? isDecisionRegistryTick(cutoffTick) && isDecisionRegistryTick(admissionsClosedTick) && finalizedTick === null
      : phase === "finalized" && isDecisionRegistryTick(cutoffTick) && isDecisionRegistryTick(admissionsClosedTick) && isDecisionRegistryTick(finalizedTick);

const hasFutureFrontier = (
  lastTick: number,
  cutoffTick: unknown,
  admissionsClosedTick: unknown,
  finalizedTick: unknown,
): boolean => [cutoffTick, admissionsClosedTick, finalizedTick].some((tick) =>
  tick !== null && (!isDecisionRegistryTick(tick) || tick > lastTick)) ||
  (isDecisionRegistryTick(cutoffTick) && isDecisionRegistryTick(admissionsClosedTick) && cutoffTick > admissionsClosedTick) ||
  (isDecisionRegistryTick(admissionsClosedTick) && isDecisionRegistryTick(finalizedTick) && admissionsClosedTick > finalizedTick);

const isDecisionReachable = (
  decision: DecisionRegistrySnapshotDecision,
  phase: unknown,
  cutoffTick: unknown,
  admissionsClosedTick: unknown,
  lastTick: number,
): boolean => decision.issuedTick <= lastTick &&
  (cutoffTick === null || decision.issuedTick <= (cutoffTick as number)) &&
  (decision.status !== "active" ||
    (phase !== "admissions_closed" && phase !== "finalized" && lastTick <= decision.validThroughTick)) &&
  (decision.status !== "expired" || (lastTick > decision.validThroughTick &&
    ((phase !== "admissions_closed" && phase !== "finalized") ||
      (isDecisionRegistryTick(admissionsClosedTick) && decision.validThroughTick < admissionsClosedTick))));

const exactObject = (input: unknown, keys: readonly string[]): Record<string, unknown> | undefined => {
  if (nodeTypes.isProxy(input) || typeof input !== "object" || input === null || Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length > 0) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || !keys.every((key) => ownKeys.includes(key))) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output[key] = descriptor.value;
  }
  return output;
};

const exactArray = (input: unknown): readonly unknown[] | undefined => {
  if (nodeTypes.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
    Object.getOwnPropertySymbols(input).length > 0) {
    return undefined;
  }
  const length = input.length;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};

export const formatDecisionRegistryId = (sequence: number): string => `decision-${String(sequence).padStart(12, "0")}`;
export const isDecisionRegistryBinding = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const isDecisionRegistryTick = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNullableTick = (value: unknown): value is number | null => value === null || isDecisionRegistryTick(value);
const isSequence = (value: unknown): value is number => isDecisionRegistryTick(value) && value >= 1 && value <= MAX_SEQUENCE + 1;
const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST_PATTERN.test(value);
const isPhase = (value: unknown): value is DecisionPhase =>
  value === "open" || value === "cutoff" || value === "admissions_closed" || value === "finalized";
const isStatus = (value: unknown): value is DecisionStatus =>
  value === "active" || value === "consumed" || value === "expired";
