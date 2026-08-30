export interface ComposedFailureCleanupStep {
  readonly label: string;
  run(): Promise<unknown>;
}

/** Runs every cleanup step in order and retains every failure. */
export const runComposedFailureCleanup = async (
  steps: readonly ComposedFailureCleanupStep[],
): Promise<readonly unknown[]> => {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) {
      failures.push(new Error(`composed cleanup failed: ${step.label}`, { cause: error }));
    }
  }
  return Object.freeze(failures);
};

/** Preserves the primary failure while guaranteeing every cleanup was attempted. */
export const throwAfterComposedFailureCleanup = async (
  primary: unknown,
  steps: readonly ComposedFailureCleanupStep[],
): Promise<never> => {
  const failures = await runComposedFailureCleanup(steps);
  if (failures.length > 0) {
    throw new AggregateError(
      [primary, ...failures],
      "composed operation failed and cleanup is incomplete",
    );
  }
  throw primary;
};
