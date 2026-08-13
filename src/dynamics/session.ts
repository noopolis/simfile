import { cloneDynamicsJson, cloneDynamicsJsonObject } from "./canonicalJson.js";
import { cloneDynamicsActionIdempotencyRecord, createDynamicsActionIdempotencyRecord,
  createDynamicsActionIngressEvidenceBuffer, dynamicsActionIdempotencyRecordCodeUnits,
  dynamicsActionKey, sameDynamicsActionAttempt } from "./actionRetention.js";
import { type DynamicsBuildReceipt } from "./buildReceipt.js";
import { DYNAMICS_ACTION_RETENTION_LIMITS, DYNAMICS_LIMITS } from "./limits.js";
import { issueDynamicsRetainedActionCapacityError } from "./retainedCapacity.js";
import { createDynamicsActionSequenceIndex } from "./sequenceWatermark.js";
import type { CreateDynamicsSessionOptions, DynamicsSession } from "./sessionContract.js";
import { issueDynamicsRetryableStepFailure, isDynamicsRetryableStepFailure,
  readCheckedDynamicsSession, registerCheckedDynamicsSession } from "./sessionIssuance.js";
import { describeRollbackFailure, requireSynchronous, restoreProviderExactly,
  sameDynamicsJson as sameJson } from "./sessionProviderBoundary.js";
import { cloneAttempt, cloneQueuedAction, cloneReceipt, freezeJson, providerCommand } from "./sessionValues.js";
import { compareDynamicsActionIdempotencyRecords, parseDynamicsSessionSnapshot } from "./snapshotValidation.js";
import { parseDynamicsSpatialFrame } from "./spatialValidation.js";
import {
  DYNAMICS_SNAPSHOT_VERSION, type DynamicsActionAttempt, type DynamicsActionIdempotencyRecord,
  type DynamicsActionIngressEvidence, type DynamicsActionQueueReceipt, type DynamicsCommand,
  type DynamicsCommitmentOutcome, type DynamicsEvent, type DynamicsInitializeContext,
  type DynamicsJsonObject, type DynamicsJsonValue,
  type DynamicsObservation, type DynamicsProvider, type DynamicsProvenance, type DynamicsQueuedAction,
  type DynamicsSessionSnapshot, type DynamicsSpatialFrame, type DynamicsStepResult,
  type ReadonlyDynamicsJsonObject
} from "./types.js";
import { parseDynamicsActionAttempt, parseDynamicsIntegration, parseDynamicsObservation,
  parseDynamicsObservationRequest, parseDynamicsProvenance, parseDynamicsSeed,
  parseDynamicsStepResult } from "./validation.js";

export type { DynamicsSession } from "./sessionContract.js";
export { isDynamicsRetryableStepFailure, readCheckedDynamicsSession } from "./sessionIssuance.js";

class CheckedDynamicsSession implements DynamicsSession {
  readonly #buildReceipt: DynamicsBuildReceipt;
  readonly #provider: DynamicsProvider;
  readonly #integration: DynamicsJsonObject;
  readonly #provenance: DynamicsProvenance;
  readonly #seed: string;
  readonly #simSecondsPerTick: number;
  #acceptedActionSequences = createDynamicsActionSequenceIndex();
  #actionIngress = new Map<string, DynamicsActionIdempotencyRecord>();
  #actionIngressFloor = 1;
  #ingressEvidence = createDynamicsActionIngressEvidenceBuffer();
  #closed?: AggregateError;
  #nextActionSequence = 1;
  #nextEventSequence = 1;
  #nextTick = 0;
  #pendingActions: DynamicsQueuedAction[] = [];
  #retainedActionCodeUnits = 0;
  #resolvedActionSequences = createDynamicsActionSequenceIndex();

  constructor(provider: DynamicsProvider, options: CreateDynamicsSessionOptions) {
    const seed = parseDynamicsSeed(options.seed);
    if (!Number.isFinite(options.simSecondsPerTick) || options.simSecondsPerTick <= 0) {
      throw new Error("dynamics simSecondsPerTick must be a positive finite number");
    }
    this.#buildReceipt = options.buildReceipt;
    this.#provider = provider;
    this.#integration = freezeJson(parseDynamicsIntegration(provider.integration));
    this.#provenance = parseDynamicsProvenance(options.provenance);
    this.#seed = seed;
    this.#simSecondsPerTick = options.simSecondsPerTick;
    const provenance = this.provenance;
    Object.freeze(provenance.provider_dependencies);
    const context: DynamicsInitializeContext = Object.freeze({
      config: freezeJson(cloneDynamicsJsonObject(options.config, "dynamics config")),
      provenance: Object.freeze(provenance),
      seed: this.#seed,
      sim_seconds_per_tick: this.#simSecondsPerTick
    });
    requireSynchronous(this.#provider.initialize(context), "initialize");
    cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("dynamics session is permanently closed after rollback failure", { cause: this.#closed });
  }

  #rollback(snapshot: DynamicsJsonValue, cause: unknown, retryableStepThrow = false): never {
    try {
      restoreProviderExactly(this.#provider, snapshot);
    } catch (restoreError) {
      this.#closed = new AggregateError(
        [cause, restoreError],
        `dynamics operation and rollback both failed\noperation: ${describeRollbackFailure(cause)}\nrollback: ${describeRollbackFailure(restoreError)}`
      );
      throw this.#closed;
    }
    throw retryableStepThrow ? issueDynamicsRetryableStepFailure(cause) : cause;
  }

  #simTime(): number {
    const value = this.#nextTick * this.#simSecondsPerTick;
    if (!Number.isFinite(value)) throw new Error("dynamics sim_time must remain finite");
    return value;
  }

  get buildReceipt(): DynamicsBuildReceipt {
    this.#assertOpen();
    return this.#buildReceipt;
  }

  get nextTick(): number {
    this.#assertOpen();
    return this.#nextTick;
  }

  get integration(): ReadonlyDynamicsJsonObject {
    this.#assertOpen();
    return freezeJson(cloneDynamicsJsonObject(this.#integration, "dynamics integration"));
  }

  get provenance(): DynamicsProvenance {
    this.#assertOpen();
    return parseDynamicsProvenance(this.#provenance);
  }

  #retainAction(key: string, record: DynamicsActionIdempotencyRecord, size: number): void {
    const evictable = [...this.#actionIngress.values()]
      .filter((candidate) => candidate.retained_at_tick < this.#nextTick)
      .sort(compareDynamicsActionIdempotencyRecords);
    let evictableIndex = 0;
    while (
      (this.#actionIngress.size >= DYNAMICS_ACTION_RETENTION_LIMITS.records
        || this.#retainedActionCodeUnits + size > DYNAMICS_ACTION_RETENTION_LIMITS.code_units)
      && evictableIndex < evictable.length
    ) {
      const oldest = evictable[evictableIndex];
      evictableIndex += 1;
      if (!oldest) break;
      this.#actionIngress.delete(dynamicsActionKey(oldest));
      this.#retainedActionCodeUnits -= dynamicsActionIdempotencyRecordCodeUnits(oldest);
    }
    if (this.#actionIngress.size >= DYNAMICS_ACTION_RETENTION_LIMITS.records) {
      throw issueDynamicsRetainedActionCapacityError("records");
    }
    if (this.#retainedActionCodeUnits + size > DYNAMICS_ACTION_RETENTION_LIMITS.code_units) {
      throw issueDynamicsRetainedActionCapacityError("code_units");
    }
    this.#actionIngress.set(key, record);
    this.#retainedActionCodeUnits += size;
  }

  readActionIngressEvidence(afterOrdinal: number): readonly DynamicsActionIngressEvidence[] {
    this.#assertOpen();
    return this.#ingressEvidence.read(afterOrdinal);
  }

  acknowledgeActionIngressEvidence(throughOrdinal: number): void {
    this.#assertOpen();
    this.#ingressEvidence.acknowledge(throughOrdinal);
  }

  queueAction(value: unknown): DynamicsActionQueueReceipt {
    this.#assertOpen();
    const attempt = parseDynamicsActionAttempt(value);
    const key = dynamicsActionKey(attempt);
    const existing = this.#actionIngress.get(key);
    if (existing) {
      const receipt: DynamicsActionQueueReceipt = sameDynamicsActionAttempt(existing, attempt)
        ? cloneReceipt(existing.receipt)
        : { act_id: attempt.act_id, apply_tick: existing.receipt.apply_tick, code: "act_id_conflict", queued: false };
      /* Replays and conflicting reuse are pure reads. Recording either here
       * would mutate the snapshot ordinal and create a second ledger cause;
       * a rejected reuse is intentionally visible only through its receipt. */
      return cloneReceipt(receipt);
    }
    if (attempt.at_tick !== this.#nextTick) {
      const receipt: DynamicsActionQueueReceipt = {
        act_id: attempt.act_id, apply_tick: this.#nextTick, code: "wrong_tick", queued: false
      };
      const record = createDynamicsActionIdempotencyRecord(attempt, receipt);
      const size = dynamicsActionIdempotencyRecordCodeUnits(record);
      this.#ingressEvidence.assertAvailable();
      this.#retainAction(key, record, size);
      this.#ingressEvidence.emit(attempt, receipt);
      return cloneReceipt(receipt);
    }
    /*
     * Per-tick queue pressure is an ordinary, retryable ingress failure and must
     * stay one: it is not a retention-capacity fault, and an attempt that fails
     * here leaves no idempotency record and no ingress evidence behind, so the
     * identical request can be retried on a later tick.
     */
    if (this.#pendingActions.length >= DYNAMICS_LIMITS.actions_per_tick) {
      throw new Error("dynamics pending action limit reached for this tick");
    }
    if (!Number.isSafeInteger(this.#nextActionSequence) || this.#nextActionSequence >= Number.MAX_SAFE_INTEGER) {
      throw issueDynamicsRetainedActionCapacityError("sequence");
    }
    const action = { ...attempt, sequence: this.#nextActionSequence };
    const receipt: DynamicsActionQueueReceipt = {
      act_id: attempt.act_id, apply_tick: this.#nextTick, queued: true, sequence: action.sequence
    };
    const record = createDynamicsActionIdempotencyRecord(attempt, receipt);
    const retainedSize = dynamicsActionIdempotencyRecordCodeUnits(record);
    this.#ingressEvidence.assertAvailable();
    this.#nextActionSequence += 1;
    this.#pendingActions.push(action);
    this.#retainAction(key, record, retainedSize);
    this.#ingressEvidence.emit(attempt, receipt);
    return cloneReceipt(receipt);
  }

  observe(value: unknown): DynamicsObservation {
    this.#assertOpen();
    const request = parseDynamicsObservationRequest(value);
    const before = cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
    try {
      const raw = requireSynchronous(this.#provider.observe(Object.freeze({
        sense_addresses: Object.freeze([...request.sense_addresses]),
        sim_time: this.#simTime(),
        tick: this.#nextTick
      })), "observe");
      const observation = parseDynamicsObservation(raw, request, this.#nextTick);
      const after = cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
      if (!sameJson(before, after)) throw new Error("dynamics provider observe() must not mutate state");
      return observation;
    } catch (error) {
      return this.#rollback(before, error);
    }
  }

  /**
   * Reads the provider's optional scene projection under the same
   * no-mutation guarantee `observe()` gets: a provider must not be able to
   * advance or perturb the simulation by being watched.
   */
  spatial(): DynamicsSpatialFrame | undefined {
    this.#assertOpen();
    if (this.#provider.spatial === undefined) return undefined;
    const before = cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
    try {
      const raw = requireSynchronous(this.#provider.spatial(), "spatial");
      const frame = parseDynamicsSpatialFrame(raw);
      const after = cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
      if (!sameJson(before, after)) throw new Error("dynamics provider spatial() must not mutate state");
      return frame;
    } catch (error) {
      return this.#rollback(before, error);
    }
  }

  step(): DynamicsStepResult {
    this.#assertOpen();
    if (this.#nextTick >= Number.MAX_SAFE_INTEGER) throw new Error("dynamics tick counter exhausted");
    if (this.#nextEventSequence >= Number.MAX_SAFE_INTEGER) throw new Error("dynamics event sequence counter exhausted");
    const simTime = this.#simTime();
    const before = cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
    const actions = this.#pendingActions.map(cloneQueuedAction);
    const commands = actions.map(providerCommand);
    try {
      let raw: unknown;
      try { raw = this.#provider.step(Object.freeze({ actions: Object.freeze(commands), dt_seconds: this.#simSecondsPerTick, sim_time: simTime, tick: this.#nextTick })); }
      catch (error) { return this.#rollback(before, error, true); }
      const checkedRaw = requireSynchronous(raw, "step");
      const parsed = parseDynamicsStepResult(checkedRaw, this.#nextTick, commands, this.#nextActionSequence);
      if (this.#nextEventSequence + parsed.events.length > Number.MAX_SAFE_INTEGER) {
        throw new Error("dynamics event sequence counter exhausted");
      }
      const acceptedThisTick = new Set(
        parsed.action_results.filter((result) => result.accepted).map((result) => result.sequence)
      );
      for (const event of parsed.events) for (const sequence of event.cause_action_sequences) {
        if (!acceptedThisTick.has(sequence) && !this.#acceptedActionSequences.has(sequence)) {
          throw new Error(`dynamics event references rejected action sequence ${sequence}`);
        }
      }
      for (const outcome of parsed.commitment_outcomes ?? []) {
        const sequence = outcome.declaration_action_sequence;
        if (!acceptedThisTick.has(sequence) && !this.#acceptedActionSequences.has(sequence)) {
          throw new Error(`dynamics commitment outcome references rejected action sequence ${sequence}`);
        }
      }
      cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot");
      const actionResults = parsed.action_results.map((resolution, index) => {
        const action = actions[index];
        if (!action) throw new Error("dynamics result had no matching action");
        return {
          ...resolution, act_id: action.act_id, action: action.action, actor: action.actor,
          apply_tick: this.#nextTick, origin: action.origin, principal_id: action.principal_id, target: action.target
        };
      });
      const events: DynamicsEvent[] = parsed.events.map((event, index) => ({
        ...event, event_sequence: this.#nextEventSequence + index, provenance: "mechanical", tick: this.#nextTick
      }));
      const commitmentOutcomes: DynamicsCommitmentOutcome[] | undefined =
        parsed.commitment_outcomes?.map((outcome) => ({
          ...outcome,
          provenance: "mechanical",
          tick: this.#nextTick,
        }));
      this.#acceptedActionSequences.addAll([...acceptedThisTick]);
      this.#resolvedActionSequences.addAll(parsed.action_results.map((result) => result.sequence));
      this.#nextEventSequence += events.length;
      this.#pendingActions = [];
      const tick = this.#nextTick;
      this.#nextTick += 1;
      this.#actionIngress = new Map([...this.#actionIngress.entries()].map(([key, record]) => {
        if (!record.receipt.queued) return [key, record] as const;
        return [key, {
          ...record,
          receipt: { act_id: record.act_id, apply_tick: this.#nextTick, code: "wrong_tick", queued: false }
        }] as const;
      }));
      this.#retainedActionCodeUnits = [...this.#actionIngress.values()]
        .reduce((total, record) => total + dynamicsActionIdempotencyRecordCodeUnits(record), 0);
      this.#actionIngressFloor = this.#nextActionSequence;
      /*
       * The tick boundary is the retention horizon for every live ingress
       * structure, evidence included. A run drains and acknowledges evidence
       * before each step, so this is a no-op there; for a host that never reads
       * evidence it is what stops an undrained buffer from accumulating across
       * ticks and turning a per-tick bound into a session-lifetime action cap.
       */
      this.#ingressEvidence.acknowledge(this.#ingressEvidence.ordinal);
      return {
        action_results: actionResults,
        ...(commitmentOutcomes === undefined ? {} : {
          commitment_outcomes: commitmentOutcomes,
        }),
        events,
        tick,
      };
    } catch (error) {
      if (isDynamicsRetryableStepFailure(error)) throw error;
      return this.#rollback(before, error);
    }
  }

  snapshot(): DynamicsSessionSnapshot {
    this.#assertOpen();
    return {
      accepted_action_sequences: this.#acceptedActionSequences.snapshot(),
      action_ingress: [...this.#actionIngress.values()]
        .sort(compareDynamicsActionIdempotencyRecords)
        .map(cloneDynamicsActionIdempotencyRecord),
      action_ingress_floor: this.#actionIngressFloor,
      action_ingress_ordinal: this.#ingressEvidence.ordinal,
      next_action_sequence: this.#nextActionSequence,
      next_event_sequence: this.#nextEventSequence,
      next_tick: this.#nextTick,
      pending_actions: this.#pendingActions.map(cloneQueuedAction),
      provider_state: cloneDynamicsJson(requireSynchronous(this.#provider.snapshot(), "snapshot"), "dynamics provider snapshot"),
      provenance: this.provenance,
      resolved_action_sequences: this.#resolvedActionSequences.snapshot(),
      seed: this.#seed,
      sim_seconds_per_tick: this.#simSecondsPerTick,
      version: DYNAMICS_SNAPSHOT_VERSION
    };
  }

  restore(value: unknown): void {
    this.#assertOpen();
    const snapshot = parseDynamicsSessionSnapshot(value);
    if (
      !sameJson(snapshot.provenance, this.#provenance)
      || snapshot.seed !== this.#seed
      || snapshot.sim_seconds_per_tick !== this.#simSecondsPerTick
    ) throw new Error("dynamics snapshot initialization identity does not match this session");
    const current = this.snapshot();
    try {
      restoreProviderExactly(this.#provider, snapshot.provider_state);
      this.#acceptedActionSequences.restore(snapshot.accepted_action_sequences);
      this.#actionIngress = new Map(snapshot.action_ingress.map((record) => [
        dynamicsActionKey(record), cloneDynamicsActionIdempotencyRecord(record)
      ]));
      this.#actionIngressFloor = snapshot.action_ingress_floor;
      this.#ingressEvidence.restore(snapshot.action_ingress_ordinal);
      this.#nextActionSequence = snapshot.next_action_sequence;
      this.#nextEventSequence = snapshot.next_event_sequence;
      this.#nextTick = snapshot.next_tick;
      this.#pendingActions = snapshot.pending_actions.map(cloneQueuedAction);
      this.#retainedActionCodeUnits = snapshot.action_ingress.reduce(
        (total, record) => total + dynamicsActionIdempotencyRecordCodeUnits(record),
        0
      );
      this.#resolvedActionSequences.restore(snapshot.resolved_action_sequences);
    } catch (error) {
      return this.#rollback(current.provider_state, error);
    }
  }
}

Object.freeze(CheckedDynamicsSession.prototype);

/** Construction is exposed only to the sealed world-service artifact entrypoint. */
export const createDynamicsSession = (
  provider: DynamicsProvider,
  options: CreateDynamicsSessionOptions
): DynamicsSession => {
  const session = new CheckedDynamicsSession(provider, options);
  Object.freeze(session);
  registerCheckedDynamicsSession(session);
  return session;
};
