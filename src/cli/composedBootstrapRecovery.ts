import {
  composedRecoveryCommand,
  createComposedRecoveryReceipt,
  markComposedJournalRecoverable,
  type ComposedJournalSession,
  type ComposedRecoveryReceipt,
} from "../compose/index.js";

export class ComposedBootstrapRecoveryError extends Error {
  readonly cause: unknown;
  readonly receipt: ComposedRecoveryReceipt;

  constructor(cause: unknown, receipt: ComposedRecoveryReceipt) {
    super("composed bootstrap requires recovery");
    this.name = "ComposedBootstrapRecoveryError";
    this.cause = cause;
    this.receipt = receipt;
  }
}

export const preserveComposedBootstrapFailure = async (
  session: ComposedJournalSession,
  cause: unknown,
): Promise<ComposedBootstrapRecoveryError> => {
  const current = session.current();
  const recoverable = current.state === "recoverable" ? current
    : markComposedJournalRecoverable(current, {
      recovery_command: composedRecoveryCommand(
        session.path, current.request.run_id, current.authority_digest,
      ),
      signal: "failure",
    });
  if (recoverable !== current) await session.replace(current, recoverable);
  return new ComposedBootstrapRecoveryError(cause, createComposedRecoveryReceipt({
    authority_digest: recoverable.authority_digest,
    journal_digest: recoverable.journal_digest,
    journal_path: session.path,
    next_phase: recoverable.interruption!.next_phase,
    preserved_evidence: false,
    run_id: recoverable.request.run_id,
    signal: "failure",
  }));
};
