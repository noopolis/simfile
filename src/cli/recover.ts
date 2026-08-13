import { composedRunConfiguration } from "../compose/execution.js";
import { openComposedJournalSession } from "../compose/journalSession.js";
import { parseComposedRecoveryArguments, recoverComposedRun } from "../compose/recovery.js";
import { serializeComposedReceipt } from "../compose/receipt.js";
import { createProductionComposedRunPorts } from "../spawnfile/productionPorts.js";

/** Restarts a composed lifecycle from its durable, nonsecret journal only. */
export const runRecoverCli = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseComposedRecoveryArguments(argv);
  const expectedAuthority = {
    authority_digest: parsed.authority_digest,
    run_id: parsed.run_id,
  };
  const journalSession = await openComposedJournalSession(
    parsed.journal_path, expectedAuthority,
  );
  const journal = journalSession.current();
  if (journal.execution === undefined) {
    throw new TypeError("composed journal does not contain production recovery inputs");
  }
  const outcome = await recoverComposedRun({
    configuration: composedRunConfiguration(journal.execution),
    expected_authority: expectedAuthority,
    journal_path: parsed.journal_path,
    journal_session: journalSession,
    ports: createProductionComposedRunPorts({
      execution: journal.execution,
      journal_session: journalSession,
    }),
  });
  process.stdout.write(serializeComposedReceipt(outcome.receipt));
  if (outcome.receipt.status === "completed") return 0;
  if (outcome.receipt.signal === "SIGINT") return 130;
  if (outcome.receipt.signal === "SIGTERM") return 143;
  return 1;
};
