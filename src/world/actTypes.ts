import type { ReadonlyDynamicsJsonObject } from "../dynamics/types.js";
import type { WorldActIngressRejectionReason } from "../world-surface/index.js";
import type { WorldRuntimeIdentity } from "./runtime.js";
export type { WorldActIngressRejectionReason } from "../world-surface/index.js";
export interface WorldActQueuedReceipt {
  readonly disposition: "queued";
  readonly receipt_id: string;
  readonly decision_id: string;
  readonly identity: WorldRuntimeIdentity;
  readonly apply_tick: number;
}
export interface WorldActIngressRejection {
  readonly disposition: "rejected_at_ingress";
  readonly code: "world_action_denied";
  readonly reason: WorldActIngressRejectionReason;
  readonly field_path?: string;
}
export type WorldActIngressReceipt = WorldActQueuedReceipt | WorldActIngressRejection;

/** Host-only bridge from action ingress to the mechanics clock. */
export interface QueuedWorldAction {
  readonly receipt_id: string; readonly decision_id: string; readonly principal: string;
  readonly holder: string; readonly affordance: string; readonly target: string;
  readonly at_tick: number; readonly dynamics_sequence: number; readonly mechanics_action: string;
  readonly mechanics_actor: string; readonly mechanics_target: string;
  readonly lowered_input: ReadonlyDynamicsJsonObject; readonly identity: WorldRuntimeIdentity;
}
export type WorldActionTerminal = Readonly<{
  disposition: "applied" | "rejected_at_mechanics"; receipt_id: string; decision_id: string;
  sequence: number; apply_tick: number; projection: "not_configured" | "projected" | "failed";
  public_code?: string; effect?: ReadonlyDynamicsJsonObject;
}>;
