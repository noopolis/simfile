import type {
  DynamicsRunActionSourceDeclaration,
  DynamicsRunActionSourceTick,
  DynamicsRunControllerAction
} from "../dynamics/runActionSource.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type { DynamicsStepResult } from "../dynamics/types.js";
import {
  createWorldRuntimeControllerAuthority,
  isWorldRuntimeControllerAuthority,
  type WorldRuntimeControllerAuthority
} from "../world/controllerAuthority.js";
import type { WorldActionRefusalReadPort } from "../world/actionRefusalJournal.js";
import type { WorldReadLedger } from "../world/ledger.js";
import type { WorldActIngressReceipt } from "../world/actTypes.js";
import { encodeWorldActEnvelope } from "../world/actEnvelope.js";
import type { DynamicsRunWorldActRequest } from "../dynamics/runActionSource.js";

export interface DynamicsRunParticipantReadPort {
  observe(participant: string, request: unknown): unknown;
}
export interface DynamicsRunParticipantActPort {
  act(participant: string, envelope: Uint8Array): WorldActIngressReceipt;
}

export interface DynamicsRunParticipantHost {
  readonly controller?: WorldRuntimeControllerAuthority;
  readonly read?: DynamicsRunParticipantReadPort;
  readonly act?: DynamicsRunParticipantActPort;
  readonly beginTick?: () => void;
  readonly refusals?: WorldActionRefusalReadPort;
  readonly readLedger?: WorldReadLedger;
  readonly readLedgerPrincipals?: readonly string[];
  readonly step?: () => DynamicsStepResult;
}

export interface DynamicsRunActionSourceHost {
  notify(simTime: number): void;
  step?(): DynamicsStepResult;
  readonly stepSettles?: boolean;
  settle(step: DynamicsStepResult): void;
}

export interface CreateDynamicsRunActionSourceHostOptions {
  readonly participantHost?: DynamicsRunParticipantHost;
  readonly session: DynamicsSession;
  readonly source: DynamicsRunActionSourceDeclaration;
}

const createStandaloneController = (
  session: DynamicsSession
): WorldRuntimeControllerAuthority => {
  const owner = {};
  let operating = false;
  let closed = false;
  const operation = Object.freeze({
    enter: (): void => {
      if (closed) throw new Error("dynamics run controller authority is closed");
      if (operating) throw new Error("dynamics run controller authority reentry");
      operating = true;
    },
    leave: (): void => {
      operating = false;
    },
    close: (): void => {
      closed = true;
    }
  });
  return createWorldRuntimeControllerAuthority(owner, {
    dynamics: session,
    operation
  });
};

export const createDynamicsRunActionSourceHost = (
  options: CreateDynamicsRunActionSourceHostOptions
): DynamicsRunActionSourceHost => {
  if (
    options.participantHost?.controller !== undefined
    && !isWorldRuntimeControllerAuthority(options.participantHost.controller)
  ) {
    throw new Error("invalid dynamics run participant controller authority");
  }
  const controller = options.participantHost?.controller
    ?? createStandaloneController(options.session);
  const participants = new Set(options.source.participants);
  let open = false;
  let actSequence = 0;
  const assertOpen = (): void => {
    if (!open) throw new Error("dynamics run action source tick is closed");
  };
  const notify = (simTime: number): void => {
    open = true;
    options.participantHost?.beginTick?.();
    const context: DynamicsRunActionSourceTick = Object.freeze({
      next_tick: options.session.nextTick,
      sim_time: simTime,
      observe: (participant: string, request: unknown): unknown => {
        assertOpen();
        if (!participants.has(participant)) {
          throw new Error(
            `dynamics run action source participant ${participant} is not declared`
          );
        }
        if (options.participantHost?.read === undefined) {
          throw new Error(
            "dynamics run participant observation is unavailable"
          );
        }
        return options.participantHost.read.observe(participant, request);
      },
      act: (participant: string, request: DynamicsRunWorldActRequest): WorldActIngressReceipt => {
        assertOpen();
        if (!participants.has(participant)) {
          throw new Error(
            `dynamics run action source participant ${participant} is not declared`
          );
        }
        if (options.participantHost?.act === undefined) {
          throw new Error("dynamics run participant action ingress is unavailable");
        }
        const envelope = encodeWorldActEnvelope({
          request_id: `run:${options.session.nextTick}:${actSequence++}`,
          affordance: request.affordance,
          target: request.target,
          input: request.input,
        });
        return options.participantHost.act.act(participant, envelope);
      },
      queueController: (action: DynamicsRunControllerAction) => {
        assertOpen();
        return controller.queue(action);
      }
    });
    try {
      options.source.onTick(context);
    } finally {
      open = false;
    }
  };
  return Object.freeze({
    notify,
    step: options.participantHost?.step ?? (() => options.session.step()),
    stepSettles: options.participantHost?.step !== undefined,
    settle: (step: DynamicsStepResult): void => {
      controller.settle(step);
    }
  });
};
