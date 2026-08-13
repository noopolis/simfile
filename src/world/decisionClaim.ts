import type { DecisionRegistry } from "./decisionRegistry.js";
import { WorldRuntimeError } from "./ledger.js";
import { types } from "node:util";

export const WORLD_DECISION_CLAIM_CAPABILITY =
  "simfile.world-decision-claim.v1" as const;
export const WORLD_DECISION_CLAIM_VALIDITY_TICKS = 30_000;

export interface WorldDecisionClaimResult {
  readonly decision_id: string;
  readonly decision_token: string;
  readonly issued_at_tick: number;
  readonly valid_through_tick: number;
}

interface CreateWorldDecisionClaimAuthorityInput {
  readonly decisionRegistry: DecisionRegistry;
  readonly principals: ReadonlySet<string>;
  readonly readTick: () => number;
}

interface WorldDecisionClaimAuthority {
  activate(): void;
  enable(): void;
  claim(principal: string, request: unknown): WorldDecisionClaimResult;
}

const authorities = new WeakMap<object, WorldDecisionClaimAuthority>();
const identifier = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 256 && value === value.trim();
const request = (value: unknown): Readonly<{ requestId: string; wakeId: string }> | undefined => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("request_id") || !keys.includes("wake_id")) return undefined;
    const requestId = Object.getOwnPropertyDescriptor(value, "request_id");
    const wakeId = Object.getOwnPropertyDescriptor(value, "wake_id");
    return requestId?.enumerable && "value" in requestId && identifier(requestId.value)
      && wakeId?.enumerable && "value" in wakeId && identifier(wakeId.value)
      ? Object.freeze({ requestId: requestId.value, wakeId: wakeId.value })
      : undefined;
  } catch { return undefined; }
};
const denied = (): never => { throw new WorldRuntimeError("world_runtime_denied"); };

export const createWorldDecisionClaimAuthority = (
  input: CreateWorldDecisionClaimAuthorityInput,
): WorldDecisionClaimAuthority => {
  let enabled = false;
  let active = false;
  let operating = false;
  const requestIds = new Set<string>();
  const wakeIds = new Set<string>();
  return Object.freeze({
    enable: (): void => { enabled = true; },
    activate: (): void => {
      if (!enabled) return denied();
      active = true;
    },
    claim: (principal: string, value: unknown): WorldDecisionClaimResult => {
      if (!enabled || !active || operating || !input.principals.has(principal)) return denied();
      const parsed = request(value);
      if (parsed === undefined || requestIds.has(parsed.requestId) || wakeIds.has(parsed.wakeId)) return denied();
      operating = true;
      try {
        const issuedTick = input.readTick();
        if (!Number.isSafeInteger(issuedTick) || issuedTick < 0) return denied();
        const validThroughTick = Math.min(
          Number.MAX_SAFE_INTEGER,
          issuedTick + WORLD_DECISION_CLAIM_VALIDITY_TICKS,
        );
        const minted = input.decisionRegistry.mint({
          principal,
          issuedTick,
          validThroughTick,
        });
        requestIds.add(parsed.requestId);
        wakeIds.add(parsed.wakeId);
        return Object.freeze({
          decision_id: minted.decisionId,
          decision_token: minted.token,
          issued_at_tick: minted.issuedTick,
          valid_through_tick: minted.validThroughTick,
        });
      } catch { return denied(); }
      finally { operating = false; }
    },
  });
};

export const registerWorldDecisionClaimAuthority = (
  runtime: object,
  authority: WorldDecisionClaimAuthority,
): void => { authorities.set(runtime, authority); };

/** @internal Sidecar host seam; deliberately absent from public package barrels. */
export const enableWorldDecisionClaim = (runtime: object): void => {
  const authority = authorities.get(runtime);
  if (authority === undefined) return denied();
  authority.enable();
};

/** @internal Authenticated topology activation seam. */
export const activateWorldDecisionClaim = (runtime: object): void => {
  const authority = authorities.get(runtime);
  if (authority === undefined) return denied();
  authority.activate();
};

export const claimWorldDecision = (
  runtime: object,
  principal: string,
  request: unknown,
): WorldDecisionClaimResult => {
  const authority = authorities.get(runtime);
  if (authority === undefined) return denied();
  return authority.claim(principal, request);
};
