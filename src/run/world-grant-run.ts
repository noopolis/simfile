import type { DynamicsSession } from "../dynamics/session.js";
import type { DynamicsStepResult } from "../dynamics/types.js";
import type { Simfile } from "../schema/model.js";
import type { WorldSurfaceRegistry } from "../world-surface/index.js";
import { composeWorldRuntimeInput } from "../world/runtimeComposition.js";
import { createWorldRuntime, type WorldRuntime } from "../world/runtime.js";
import { readWorldRuntimeClockAuthority } from "../world/clockAuthority.js";
import { readWorldRuntimeControllerAuthority } from "../world/controllerAuthority.js";
import { readWorldRuntimeActionRefusalJournalInspection } from
  "../world/actionJournalInspection.js";
import type { WorldReadLedger } from "../world/ledger.js";
import type {
  DynamicsRunParticipantHost,
  DynamicsRunParticipantReadPort
} from "./dynamics-run-action-source.js";
import type { DynamicsRunParticipantActPort } from "./dynamics-run-action-source.js";

export type DynamicsRunWorldGrantMarker = Readonly<{
  observed: boolean;
  participants: readonly string[];
  resolved: boolean;
  status: "none-declared" | "declared-unresolved" | "declared-resolved";
}>;

export interface DynamicsRunWorldGrantState {
  readonly participantHost?: DynamicsRunParticipantHost;
  marker(): DynamicsRunWorldGrantMarker;
}

export interface PrepareDynamicsRunWorldGrantsInput {
  readonly participantHost?: DynamicsRunParticipantHost;
  readonly runId: string;
  readonly session: DynamicsSession;
  readonly simfile: Simfile;
  readonly surfaceRegistry?: WorldSurfaceRegistry;
}

const marker = (
  participants: readonly string[],
  status: DynamicsRunWorldGrantMarker["status"],
  observed = false
): DynamicsRunWorldGrantMarker => Object.freeze({
  observed,
  participants: Object.freeze([...participants]),
  resolved: status === "declared-resolved",
  status
});

const participantPorts = (
  runtime: WorldRuntime,
  participants: readonly string[],
  principalByParticipant: ReadonlyMap<string, string>,
  mint: (participant: string) => { readonly token: string },
  didObserve: () => void
): Readonly<{ read: DynamicsRunParticipantReadPort; act: DynamicsRunParticipantActPort; beginTick(): void }> => {
  const active = new Map<string, { readonly token: string }>();
  return Object.freeze({
    beginTick: (): void => {
      active.clear();
      for (const participant of participants) active.set(participant, mint(participant));
    },
    read: Object.freeze({
      observe: (participant: string, request: unknown): unknown => {
        const principal = principalByParticipant.get(participant);
        const decision = active.get(participant);
        if (principal === undefined || decision === undefined) {
          throw new Error("dynamics run participant observation denied");
        }
        didObserve();
        return runtime.observe({ principal, decisionToken: decision.token }, request);
      }
    }),
    act: Object.freeze({
      act: (participant: string, envelope: Uint8Array) => {
        const principal = principalByParticipant.get(participant);
        const decision = active.get(participant);
        if (principal === undefined || decision === undefined) {
          throw new Error("dynamics run participant action denied");
        }
        return runtime.act({ principal, decisionToken: decision.token }, envelope);
      }
    })
  });
};

export class WorldRunCompositionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorldRunCompositionError";
  }
}

export const prepareDynamicsRunWorldGrants = (
  input: PrepareDynamicsRunWorldGrantsInput
): DynamicsRunWorldGrantState => {
  const participants = Object.keys(input.simfile.world?.grants ?? {}).sort();
  if (participants.length === 0) {
    return Object.freeze({
      ...(input.participantHost === undefined
        ? {}
        : { participantHost: input.participantHost }),
      marker: () => marker(participants, "none-declared")
    });
  }
  if (input.simfile.world === undefined || input.surfaceRegistry === undefined) {
    return Object.freeze({
      ...(input.participantHost === undefined
        ? {}
        : { participantHost: input.participantHost }),
      marker: () => marker(participants, "declared-unresolved")
    });
  }

  if (input.participantHost?.controller !== undefined) {
    throw new WorldRunCompositionError(
      "caller-supplied dynamics run participant controller conflicts with resolved world runtime"
    );
  }
  if (input.participantHost?.read !== undefined) {
    throw new Error(
      "caller-supplied dynamics run participant read port conflicts with resolved world grants"
    );
  }
  if (input.participantHost?.refusals !== undefined) {
    throw new WorldRunCompositionError(
      "caller-supplied dynamics run refusal port conflicts with resolved world runtime"
    );
  }
  if (input.participantHost?.readLedger !== undefined) {
    throw new WorldRunCompositionError(
      "caller-supplied dynamics run read ledger conflicts with resolved world runtime"
    );
  }
  const runtimeInput = composeWorldRuntimeInput({
    runId: input.runId,
    surfaceRegistry: input.surfaceRegistry,
    world: input.simfile.world,
    worldInstanceId: `${input.runId}-world`,
    session: input.session,
    maxEntriesPerPrincipal: 256,
    maxPrincipals: participants.length,
  });
  const runtime = createWorldRuntime(runtimeInput);
  const manifests = new Map(runtimeInput.boundGrants.map((grant) => [grant.participant, grant.principal]));
  let observed = false;
  const ports = participantPorts(
    runtime,
    participants,
    manifests,
    (participant) => runtimeInput.decisionRegistry.mint({
      principal: manifests.get(participant)!,
      issuedTick: input.session.nextTick,
      validThroughTick: input.session.nextTick,
    }),
    () => { observed = true; }
  );
  const clock = readWorldRuntimeClockAuthority(runtime);
  const controller = readWorldRuntimeControllerAuthority(runtime);
  if (clock === undefined || controller === undefined) {
    throw new WorldRunCompositionError(
      "resolved world runtime is missing its clock or controller authority"
    );
  }
  const refusals = readWorldRuntimeActionRefusalJournalInspection(runtime);
  if (refusals === undefined) {
    throw new WorldRunCompositionError(
      "resolved world runtime is missing its refusal journal"
    );
  }
  const participantHost = Object.freeze({
    controller,
    refusals,
    readLedger: runtimeInput.readLedger as WorldReadLedger,
    readLedgerPrincipals: Object.freeze([...manifests.values()].sort()),
    read: ports.read,
    act: ports.act,
    beginTick: ports.beginTick,
    step: (): DynamicsStepResult => {
      const result = clock.stepDynamics();
      return result.raw_step;
    }
  });
  return Object.freeze({
    participantHost,
    marker: () => marker(participants, "declared-resolved", observed)
  });
};
