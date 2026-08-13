export const WORLD_ACT_INGRESS_REJECTION_REASONS = Object.freeze([
  "request_malformed",
  "request_conflict",
  "principal_unknown",
  "ingress_reentered",
  "ingress_closed",
  "capacity_exhausted",
  "decision_token_invalid",
  "decision_token_expired",
  "decision_token_consumed",
  "affordance_not_granted",
  "target_not_granted",
  "resource_undeclared",
  "affordance_unavailable",
  "action_input_malformed",
  "action_input_missing_field",
  "action_input_unknown_field",
  "action_input_wrong_type",
  "action_input_out_of_bounds",
  "action_input_not_allowed_value",
  "world_surface_failed",
  "world_state_unstable",
  "internal_error",
] as const);

export type WorldActIngressRejectionReason =
  (typeof WORLD_ACT_INGRESS_REJECTION_REASONS)[number];

export interface WorldSurfaceRejectionDetail {
  readonly reason: WorldActIngressRejectionReason;
  readonly fieldPath?: string;
}

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/u;
const issuedRejections = new WeakSet<object>();

export const isWorldActIngressRejectionReason = (
  value: unknown,
): value is WorldActIngressRejectionReason =>
  typeof value === "string"
  && (WORLD_ACT_INGRESS_REJECTION_REASONS as readonly string[]).includes(value);

export const isWorldActIngressRejectionFieldPath = (
  value: unknown,
): value is string => typeof value === "string" && value.length <= 256 && FIELD_PATH.test(value);

export class WorldSurfaceActionInputRejection extends TypeError {
  readonly reason: WorldActIngressRejectionReason;
  declare readonly fieldPath?: string;

  constructor(
    message: string,
    reason: WorldActIngressRejectionReason,
    fieldPath?: string,
  ) {
    super(message);
    this.name = "WorldSurfaceActionInputRejection";
    const bounded = isWorldActIngressRejectionReason(reason)
      && (fieldPath === undefined || isWorldActIngressRejectionFieldPath(fieldPath));
    this.reason = bounded ? reason : "internal_error";
    if (bounded && fieldPath !== undefined) {
      Object.defineProperty(this, "fieldPath", {
        configurable: false,
        enumerable: true,
        value: fieldPath,
        writable: false,
      });
    }
    issuedRejections.add(this);
    Object.freeze(this);
  }
}

export const readWorldSurfaceRejection = (
  error: unknown,
): WorldSurfaceRejectionDetail | undefined => {
  if (error === null || typeof error !== "object" || !issuedRejections.has(error)) {
    return undefined;
  }
  const rejection = error as WorldSurfaceActionInputRejection;
  return Object.freeze({
    reason: rejection.reason,
    ...(rejection.fieldPath === undefined ? {} : { fieldPath: rejection.fieldPath }),
  });
};
