import {
  COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION,
  composedRunConfiguration,
  openComposedJournalSession,
  parseComposedRecoveryArguments,
  recoverComposedRun,
  serializeComposedReceipt,
} from "../compose/index.js";
import { createProductionComposedRunPorts } from "../spawnfile/productionPorts.js";
import { finalizeComposedBootstrap } from "./composedBootstrapFinalize.js";
import { reconstructComposedBootstrap } from "./composedBootstrapRecoverState.js";
import { preserveComposedBootstrapFailure } from "./composedBootstrapRecovery.js";

const exitCode = (signal: "SIGINT" | "SIGTERM" | "failure" | "restart"): number =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;

/** Reconstructs provider authority solely from the durable secret-free capsule. */
export const runRecoverCli = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseComposedRecoveryArguments(argv);
  const expectedAuthority = { authority_digest: parsed.authority_digest,
    run_id: parsed.run_id };
  const journalSession = await openComposedJournalSession(
    parsed.journal_path, expectedAuthority,
  );
  const initial = journalSession.current();
  if (initial.version !== COMPOSED_PHASE_JOURNAL_BOOTSTRAP_VERSION
    || initial.bootstrap === undefined) {
    if (initial.execution === undefined) {
      throw new TypeError("legacy unbound composed journals cannot be recovered");
    }
    throw new TypeError(
      "legacy composed journal lacks the public target bootstrap capsule required for recovery",
    );
  }
  let bootstrap;
  try {
    const prepared = await reconstructComposedBootstrap({
      capsule: initial.bootstrap,
      journal_session: journalSession,
    });
    bootstrap = await finalizeComposedBootstrap(prepared);
  } catch (error) {
    const recovery = await preserveComposedBootstrapFailure(journalSession, error);
    process.stdout.write(serializeComposedReceipt(recovery.receipt));
    return exitCode(recovery.receipt.signal);
  }
  try {
    const outcome = await recoverComposedRun({
      configuration: composedRunConfiguration(bootstrap.execution),
      expected_authority: expectedAuthority,
      journal_path: parsed.journal_path,
      journal_session: journalSession,
      ports: createProductionComposedRunPorts({
        execution: bootstrap.execution,
        journal_session: journalSession,
        target_provider: bootstrap.target_provider,
      }),
    });
    process.stdout.write(serializeComposedReceipt(outcome.receipt));
    return outcome.receipt.status === "completed" ? 0 : exitCode(outcome.receipt.signal);
  } finally {
    bootstrap.target_provider.close();
  }
};
