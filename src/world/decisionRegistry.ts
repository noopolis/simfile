import { createHash, createHmac, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  createDecisionRegistryInspection,
  createDecisionRegistrySnapshot,
  parseDecisionRegistrySnapshot,
  formatDecisionRegistryId,
  isDecisionRegistryTick,
  parseDecisionRegistryTestingOptions,
} from "./decisionRegistrySnapshot.js";
import { copySafeUint8Array } from "./decisionRegistrySnapshot.js";
import { parseDecisionAdmissionRequest, parseDecisionMintRequest, parseDecisionRegistryConfig } from "./decisionRegistryInput.js";
import type { DecisionRegistrySnapshot, ParsedDecisionRegistrySnapshot } from "./decisionRegistrySnapshot.js";
import { registerConsumedDecisionResultVerifier } from "./decisionResultReadAdmission.js";

const TOKEN_BYTES = 32;
const MAX_ENTROPY_DRAWS = 16;
const TOKEN_DOMAIN = "simfile.decision-token.v1\0";
const MAX_DECISION_SEQUENCE = 999_999_999_999;
const ERROR_MESSAGES = {
  invalid_config: "Invalid decision registry configuration.", invalid_input: "Invalid decision registry input.",
  tick_regression: "Decision registry tick regressed.", mint_closed: "Decision minting is closed.",
  active_decision_exists: "An active decision already exists for this principal.", entropy_failure: "Decision token entropy failed.",
  token_invalid: "Decision token admission failed.", token_expired: "Decision token has expired.",
  token_consumed: "Decision token has already been consumed.", admissions_closed: "Decision admissions are closed.",
  invalid_transition: "Invalid decision registry phase transition.", active_decisions_remain: "Active decisions remain.",
  invalid_snapshot: "Invalid decision registry snapshot.", restore_not_pristine: "Decision registry restore requires a pristine registry.",
  sequence_exhausted: "Decision registry sequence is exhausted.",
} as const;
export type DecisionRegistryErrorCode = keyof typeof ERROR_MESSAGES;
export type DecisionPhase = "open" | "cutoff" | "admissions_closed" | "finalized";
export type DecisionStatus = "active" | "consumed" | "expired";
const issuedDecisionRegistryErrors = new WeakSet<object>();
export class DecisionRegistryError extends Error {
  public readonly code: DecisionRegistryErrorCode;
  public constructor(code: DecisionRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DecisionRegistryError";
    this.code = code;
    issuedDecisionRegistryErrors.add(this);
  }
}
/** WeakSet authentication rejects caller objects that spoof `instanceof` or the code shape. */
export const readDecisionRegistryErrorCode = (value: unknown): DecisionRegistryErrorCode | undefined => {
  const descriptor = value !== null && typeof value === "object" && issuedDecisionRegistryErrors.has(value) ? Object.getOwnPropertyDescriptor(value, "code") : undefined;
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" && Object.hasOwn(ERROR_MESSAGES, descriptor.value) ? descriptor.value as DecisionRegistryErrorCode : undefined;
};
export interface DecisionRegistryConfig { readonly runId: string; readonly worldInstanceId: string; readonly tokenDigestKey: Uint8Array; }
interface DecisionTiming { readonly issuedTick: number; readonly validThroughTick: number; }
interface DecisionBinding { readonly runId: string; readonly worldInstanceId: string; }
export interface DecisionMintRequest extends DecisionTiming { readonly principal: string; }
export interface DecisionAdmissionRequest extends DecisionBinding { readonly principal: string; readonly token: string; readonly atTick: number; }
export interface DecisionMintResult extends DecisionTiming { readonly decisionId: string; readonly token: string; }
export interface DecisionAdmission extends DecisionBinding, DecisionTiming {
  readonly decisionId: string;
  readonly principal: string;
  readonly status: DecisionStatus;
  readonly tokenDigest: string;
}
export interface DecisionReadAdmission extends DecisionTiming { readonly decisionId: string; readonly status: "active"; readonly phase: "open" | "cutoff"; }
interface DecisionResultReadVerification extends DecisionBinding, DecisionTiming { readonly decisionId: string; readonly principal: string; readonly status: "consumed"; readonly atTick: number; }
export interface DecisionRegistryInspection {
  readonly phase: DecisionPhase;
  readonly cutoffTick: number | null;
  readonly admissionsClosedTick: number | null;
  readonly finalizedTick: number | null;
  readonly lastTick: number | null;
  readonly nextDecisionSequence: number;
  readonly decisions: readonly DecisionAdmission[];
}
export interface DecisionRegistry {
  mint(input: unknown): DecisionMintResult;
  peekReadAdmission(input: unknown): DecisionReadAdmission;
  admitRead(input: unknown): DecisionAdmission;
  /** B22 calls this only after bearer, grant, and schema checks have succeeded. */
  consumeForAct(input: unknown): DecisionAdmission;
  beginCutoff(atTick: unknown): void;
  closeAdmissions(atTick: unknown): void;
  finalize(atTick: unknown): void;
  inspect(): DecisionRegistryInspection;
  snapshot(): DecisionRegistrySnapshot;
  restore(input: unknown): void;
}
export interface DecisionActReservation { readonly decisionId: string; abort(): void; commit(): void; }
const issuedDecisionRegistries = new WeakSet<object>();
const issuedActReservations = new WeakSet<object>();
const reservationIssuers = new WeakMap<object, (input: unknown, commitExpired?: boolean) => DecisionActReservation>();
export const readDecisionRegistry = (value: unknown): DecisionRegistry | undefined =>
  value !== null && typeof value === "object" && issuedDecisionRegistries.has(value) ? value as DecisionRegistry : undefined;
export const reserveDecisionForAct = (registry: unknown, input: unknown): DecisionActReservation => {
  const reserve = registry !== null && typeof registry === "object" ? reservationIssuers.get(registry) : undefined;
  if (reserve === undefined) throw error("invalid_input");
  return reserve(input, false);
};
export const readDecisionActReservation = (value: unknown): DecisionActReservation | undefined =>
  value !== null && typeof value === "object" && issuedActReservations.has(value) ? value as DecisionActReservation : undefined;
interface DecisionRecord extends DecisionAdmission { status: DecisionStatus; }
interface LiveState { readonly records: Map<string, DecisionRecord>; readonly activeByPrincipal: Map<string, string>; readonly phase: DecisionPhase; readonly cutoffTick: number | null; readonly admissionsClosedTick: number | null; readonly finalizedTick: number | null; readonly lastTick: number | null; readonly nextDecisionSequence: number; readonly restoreAllowed: boolean; }
type EntropySource = (size: number) => Uint8Array;
export const createDecisionRegistry = (config: unknown): DecisionRegistry => createRegistry(config, cryptoRandomBytes, MAX_DECISION_SEQUENCE);
export const createDecisionRegistryForTesting = (
  config: unknown,
  options: unknown,
): DecisionRegistry => {
  const parsed = parseDecisionRegistryTestingOptions(options, MAX_DECISION_SEQUENCE);
  if (parsed === undefined) throw error("invalid_config");
  return createRegistry(config, parsed.randomBytes, parsed.maxDecisionSequence ?? MAX_DECISION_SEQUENCE);
};
const createRegistry = (configInput: unknown, entropy: EntropySource, maxDecisionSequence: number): DecisionRegistry => {
  const config = parseDecisionRegistryConfig(configInput);
  if (config === undefined) throw error("invalid_config");
  const fingerprint = fingerprintKey(config.tokenDigestKey);
  let live = pristineState();
  let operating = false;
  let reentered = false;
  let reservationActive = false;
  const operate = <T>(fallback: DecisionRegistryErrorCode, action: () => T): T => {
    if (operating || reservationActive) {
      reentered = true;
      throw error("invalid_input");
    }
    operating = true;
    reentered = false;
    try {
      return action();
    } catch (cause) {
      if (cause instanceof DecisionRegistryError) throw cause;
      throw error(fallback);
    } finally {
      operating = false;
      reentered = false;
    }
  };
  const assertNotReentered = (): void => {
    if (reentered) throw error("entropy_failure");
  };
  const checkTick = (input: unknown): number => {
    if (!isDecisionRegistryTick(input)) throw error("invalid_input");
    if (live.lastTick !== null && input < live.lastTick) throw error("tick_regression");
    return input;
  };
  const commitTick = (atTick: number): void => {
    live = { ...live, lastTick: atTick };
    for (const record of live.records.values()) {
      if (record.status !== "active" || atTick <= record.validThroughTick) continue;
      record.status = "expired";
      if (live.activeByPrincipal.get(record.principal) === record.tokenDigest) {
        live.activeByPrincipal.delete(record.principal);
      }
    }
  };
  /* Build the complete post-consumption graph before the transaction boundary.
   * The successful reservation commit is deliberately only a pointer swap. */
  const consumedState = (record: DecisionRecord, atTick: number): LiveState => {
    const records = new Map<string, DecisionRecord>();
    const activeByPrincipal = new Map(live.activeByPrincipal);
    for (const [digest, current] of live.records) {
      let next: DecisionRecord = current;
      if (current === record) next = { ...current, status: "consumed" };
      else if (current.status === "active" && atTick > current.validThroughTick) {
        next = { ...current, status: "expired" };
        if (activeByPrincipal.get(current.principal) === digest) activeByPrincipal.delete(current.principal);
      }
      records.set(digest, next);
    }
    if (activeByPrincipal.get(record.principal) === record.tokenDigest) activeByPrincipal.delete(record.principal);
    return { records, activeByPrincipal, phase: live.phase, cutoffTick: live.cutoffTick,
      admissionsClosedTick: live.admissionsClosedTick, finalizedTick: live.finalizedTick,
      lastTick: atTick, nextDecisionSequence: live.nextDecisionSequence, restoreAllowed: false };
  };
  const verifyAdmission = (input: unknown, commitExpired: boolean): { record: DecisionRecord; atTick: number } => {
    const request = parseDecisionAdmissionRequest(input);
    if (request === undefined) throw error("invalid_input");
    const atTick = checkTick(request.atTick);
    if (live.phase === "admissions_closed" || live.phase === "finalized") {
      throw error("admissions_closed");
    }
    const record = live.records.get(digestToken(config, request.token));
    if (record === undefined || record.principal !== request.principal || request.runId !== config.runId ||
      request.worldInstanceId !== config.worldInstanceId || atTick < record.issuedTick) {
      throw error("token_invalid");
    }
    if (record.status === "expired") throw error("token_expired");
    if (record.status === "consumed") throw error("token_consumed");
    if (atTick > record.validThroughTick) {
      if (commitExpired) commitTick(atTick);
      throw error("token_expired");
    }
    return { record, atTick };
  };
  const transition = (
    input: unknown,
    expected: DecisionPhase,
    next: Exclude<DecisionPhase, "open">,
    frontier: "cutoffTick" | "admissionsClosedTick" | "finalizedTick",
    beforeCommit?: (atTick: number) => void,
  ): void => {
    const atTick = checkTick(input);
    if (live.phase !== expected) throw error("invalid_transition");
    beforeCommit?.(atTick);
    live = { ...live, phase: next, [frontier]: atTick };
    commitTick(atTick);
    live = { ...live, restoreAllowed: false };
  };
  const reserveForAct = (input: unknown, commitExpired = false): DecisionActReservation => operate("invalid_input", () => {
    const { record, atTick } = verifyAdmission(input, commitExpired);
    const committed = consumedState(record, atTick);
    reservationActive = true;
    type ReservationOperation = () => void;
    const staleUse: ReservationOperation = () => { throw error("token_invalid"); };
    let commitOperation: ReservationOperation;
    let abortOperation: ReservationOperation;
    const successfulCommit: ReservationOperation = () => {
      live = committed;
      reservationActive = false;
      commitOperation = staleUse;
      abortOperation = staleUse;
    };
    const exactAbort: ReservationOperation = () => {
      reservationActive = false;
      commitOperation = staleUse;
      abortOperation = staleUse;
    };
    commitOperation = successfulCommit;
    abortOperation = exactAbort;
    const reservation: DecisionActReservation = Object.freeze({
      decisionId: record.decisionId,
      abort: () => abortOperation(),
      commit: () => commitOperation(),
    });
    issuedActReservations.add(reservation);
    return reservation;
  });
  const verifyConsumedResultRead = (input: unknown): DecisionResultReadVerification => operate("invalid_input", () => {
    const request = parseDecisionAdmissionRequest(input); if (request === undefined) throw error("invalid_input");
    const atTick = checkTick(request.atTick); if (live.phase === "admissions_closed" || live.phase === "finalized") throw error("admissions_closed");
    const record = live.records.get(digestToken(config, request.token));
    if (record === undefined || record.status !== "consumed" || record.principal !== request.principal || request.runId !== config.runId || request.worldInstanceId !== config.worldInstanceId) throw error("token_invalid");
    if (atTick < record.issuedTick) throw error("token_invalid"); if (atTick > record.validThroughTick) throw error("token_expired");
    return freeze({ decisionId: record.decisionId, principal: record.principal, runId: record.runId, worldInstanceId: record.worldInstanceId, issuedTick: record.issuedTick, validThroughTick: record.validThroughTick, status: "consumed", atTick });
  });
  const registry: DecisionRegistry = Object.freeze({
    mint: (input: unknown) => operate("entropy_failure", () => {
      const request = parseDecisionMintRequest(input);
      if (request === undefined) throw error("invalid_input");
      const issuedTick = checkTick(request.issuedTick);
      if (live.phase !== "open") throw error("mint_closed");
      const activeDigest = live.activeByPrincipal.get(request.principal);
      if (activeDigest !== undefined && issuedTick <= live.records.get(activeDigest)!.validThroughTick) {
        throw error("active_decision_exists");
      }
      if (live.nextDecisionSequence > maxDecisionSequence) throw error("sequence_exhausted");
      const minted = mintToken(config, entropy, live.records, assertNotReentered);
      const decisionId = formatDecisionRegistryId(live.nextDecisionSequence);
      const record: DecisionRecord = {
        decisionId,
        principal: request.principal,
        runId: config.runId,
        worldInstanceId: config.worldInstanceId,
        status: "active",
        issuedTick,
        validThroughTick: request.validThroughTick,
        tokenDigest: minted.digest,
      };
      commitTick(issuedTick);
      live.records.set(minted.digest, record);
      live.activeByPrincipal.set(request.principal, minted.digest);
      live = {
        ...live,
        nextDecisionSequence: live.nextDecisionSequence + 1,
        restoreAllowed: false,
      };
      return freeze({ decisionId, token: minted.token, issuedTick, validThroughTick: request.validThroughTick });
    }),
    peekReadAdmission: (input: unknown) => operate("invalid_input", () => {
      const { record } = verifyAdmission(input, false);
      return readAdmission(record, live.phase as "open" | "cutoff");
    }),
    admitRead: (input: unknown) => operate("invalid_input", () => {
      const { record, atTick } = verifyAdmission(input, true);
      commitTick(atTick);
      return publicRecord(record);
    }),
    consumeForAct: (input: unknown) => {
      const reservation = reserveForAct(input, true);
      const request = parseDecisionAdmissionRequest(input);
      const record = request === undefined ? undefined : live.records.get(digestToken(config, request.token));
      if (record === undefined) { reservation.abort(); throw error("token_invalid"); }
      const result = publicRecord({ ...record, status: "consumed" });
      reservation.commit();
      return result;
    },
    beginCutoff: (input: unknown) => operate("invalid_input", () =>
      transition(input, "open", "cutoff", "cutoffTick")),
    closeAdmissions: (input: unknown) => operate("invalid_input", () =>
      transition(input, "cutoff", "admissions_closed", "admissionsClosedTick", (atTick) => {
        if (hasActiveDecisionAt(live.records, atTick)) throw error("active_decisions_remain");
      })),
    finalize: (input: unknown) => operate("invalid_input", () =>
      transition(input, "admissions_closed", "finalized", "finalizedTick")),
    inspect: () => operate("invalid_input", () => createDecisionRegistryInspection(live, [...live.records.values()].sort(byId))),
    snapshot: () => operate("invalid_snapshot", () => createDecisionRegistrySnapshot(
      config.runId, config.worldInstanceId, fingerprint, live, [...live.records.values()].sort(byId),
    )),
    restore: (input: unknown) => operate("invalid_snapshot", () => {
      if (!live.restoreAllowed) throw error("restore_not_pristine");
      const parsed = parseDecisionRegistrySnapshot(input, {
        runId: config.runId,
        worldInstanceId: config.worldInstanceId,
        tokenDigestKeyFingerprint: fingerprint,
      });
      if (parsed === undefined) throw error("invalid_snapshot");
      live = restoredState(parsed, config);
    }),
  });
  issuedDecisionRegistries.add(registry);
  reservationIssuers.set(registry, reserveForAct);
  registerConsumedDecisionResultVerifier(registry, verifyConsumedResultRead);
  return registry;
};
const mintToken = (
  config: DecisionRegistryConfig,
  entropy: EntropySource,
  records: ReadonlyMap<string, DecisionRecord>,
  assertNotReentered: () => void,
): { token: string; digest: string } => {
  for (let draw = 0; draw < MAX_ENTROPY_DRAWS; draw += 1) {
    let candidate: unknown;
    try {
      candidate = entropy(TOKEN_BYTES);
    } catch {
      throw error("entropy_failure");
    }
    assertNotReentered();
    const bytes = copySafeUint8Array(candidate);
    if (bytes === undefined || bytes.byteLength !== TOKEN_BYTES) throw error("entropy_failure");
    const token = Buffer.from(bytes).toString("base64url");
    const digest = digestToken(config, token);
    if (!records.has(digest)) return { token, digest };
  }
  throw error("entropy_failure");
};
const pristineState = (): LiveState => ({
  records: new Map(),
  activeByPrincipal: new Map(),
  phase: "open",
  cutoffTick: null,
  admissionsClosedTick: null,
  finalizedTick: null,
  lastTick: null,
  nextDecisionSequence: 1,
  restoreAllowed: true,
});
const restoredState = (
  snapshot: ParsedDecisionRegistrySnapshot,
  config: DecisionRegistryConfig,
): LiveState => {
  const records = new Map<string, DecisionRecord>();
  const activeByPrincipal = new Map<string, string>();
  for (const decision of snapshot.decisions) {
    const record: DecisionRecord = {
      ...decision,
      runId: config.runId,
      worldInstanceId: config.worldInstanceId,
    };
    records.set(record.tokenDigest, record);
    if (record.status === "active") activeByPrincipal.set(record.principal, record.tokenDigest);
  }
  return {
    records,
    activeByPrincipal,
    phase: snapshot.phase,
    cutoffTick: snapshot.cutoffTick,
    admissionsClosedTick: snapshot.admissionsClosedTick,
    finalizedTick: snapshot.finalizedTick,
    lastTick: snapshot.lastTick,
    nextDecisionSequence: snapshot.nextDecisionSequence,
    restoreAllowed: false,
  };
};
const hasActiveDecisionAt = (records: ReadonlyMap<string, DecisionRecord>, atTick: number): boolean =>
  [...records.values()].some((record) => record.status === "active" && atTick <= record.validThroughTick);
const digestToken = (config: DecisionRegistryConfig, token: string): string =>
  `sha256:${createHmac("sha256", config.tokenDigestKey)
    .update(TOKEN_DOMAIN).update(config.runId).update("\0").update(token).digest("hex")}`;
const fingerprintKey = (key: Uint8Array): string =>
  `sha256:${createHash("sha256").update(key).digest("hex")}`;
const publicRecord = (record: DecisionRecord): DecisionAdmission => freeze({ ...record });
const readAdmission = (record: DecisionRecord, phase: "open" | "cutoff"): DecisionReadAdmission => freeze({
  decisionId: record.decisionId, status: "active", issuedTick: record.issuedTick, validThroughTick: record.validThroughTick, phase,
});
const byId = (left: DecisionRecord, right: DecisionRecord): number =>
  left.decisionId === right.decisionId ? 0 : left.decisionId < right.decisionId ? -1 : 1;
const error = (code: DecisionRegistryErrorCode): DecisionRegistryError => new DecisionRegistryError(code);
const freeze = <T>(value: T): T => Object.freeze(value);
