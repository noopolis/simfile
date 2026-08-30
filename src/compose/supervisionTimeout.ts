const boundedTimeout = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`composed ${label} timeout is invalid`);
  }
  return value;
};

const awaitOperationQuiescence = async (
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          "composed terminal port did not quiesce after abort",
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const waitForComposedTerminal = async (input: Readonly<{
  operation(signal: AbortSignal): Promise<unknown>;
  operator_timeout_ms: number;
  quiescence_timeout_ms: number;
  signal: AbortSignal;
}>): Promise<unknown> => {
  boundedTimeout(input.operator_timeout_ms, "operator", 86_400_000);
  boundedTimeout(input.quiescence_timeout_ms, "quiescence", 60_000);
  if (input.signal.aborted) throw input.signal.reason;
  const operationController = new AbortController();
  let cancelled = false;
  let cancellationReason: unknown;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const cancel = (reason: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      cancellationReason = reason;
      reject(reason);
      operationController.abort(reason);
    };
    timeout = setTimeout(() => cancel(new Error(
      "composed world supervision reached the operator timeout",
    )), input.operator_timeout_ms);
    onAbort = () => cancel(input.signal.reason);
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
  const operation = Promise.resolve().then(() => input.operation(operationController.signal));
  try {
    return await Promise.race([operation, cancellation]);
  } catch (error) {
    if (!cancelled) throw error;
    try { await awaitOperationQuiescence(operation, input.quiescence_timeout_ms); }
    catch (quiescenceError) {
      throw new AggregateError(
        [cancellationReason, quiescenceError],
        "composed terminal cancellation failed to quiesce its port",
      );
    }
    throw cancellationReason;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) input.signal.removeEventListener("abort", onAbort);
  }
};
