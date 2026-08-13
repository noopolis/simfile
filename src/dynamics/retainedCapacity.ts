const issuedCapacityErrors = new WeakSet<object>();

type RetainedCapacityKind = "records" | "code_units" | "sequence";
export type DynamicsRetainedActionCapacityError = Error & { readonly kind: RetainedCapacityKind };

export const dynamicsRetainedActionCapacityMessage = (kind: RetainedCapacityKind): string =>
  `dynamics retained action ${kind} capacity reached`;

class IssuedDynamicsRetainedActionCapacityError extends Error {
  readonly kind: RetainedCapacityKind;

  constructor(kind: RetainedCapacityKind) {
    super(dynamicsRetainedActionCapacityMessage(kind));
    this.name = "DynamicsRetainedActionCapacityError";
    this.kind = kind;
    issuedCapacityErrors.add(this);
  }
}

export const issueDynamicsRetainedActionCapacityError = (
  kind: RetainedCapacityKind,
): DynamicsRetainedActionCapacityError => new IssuedDynamicsRetainedActionCapacityError(kind);

export const isDynamicsRetainedActionCapacityError = (
  value: unknown,
): value is DynamicsRetainedActionCapacityError =>
  value instanceof Error && issuedCapacityErrors.has(value) &&
  (value as DynamicsRetainedActionCapacityError).name === "DynamicsRetainedActionCapacityError";
