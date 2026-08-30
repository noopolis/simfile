import path from "node:path";

import type { ComposedJournalAuthorityExpectation } from "./journalSession.js";
import {
  recoverComposedRun,
  type ComposedRunOutcome,
} from "./recovery.js";
import type { ComposedRunConfiguration, ComposedRunPorts } from "./run.js";
import type { ComposedRunFaultInjector } from "./types.js";

export interface ComposedRecoveryArguments extends ComposedJournalAuthorityExpectation {
  readonly journal_path: string;
}

export const parseComposedRecoveryArguments = (
  argv: readonly string[],
): ComposedRecoveryArguments => {
  const [journalFlag, journalPath, runFlag, runId, authorityFlag, authorityDigest, ...extra] = argv;
  if (journalFlag !== "--journal" || journalPath === undefined
    || runFlag !== "--run-id" || runId === undefined
    || authorityFlag !== "--authority-digest" || authorityDigest === undefined
    || extra.length > 0 || !path.isAbsolute(journalPath) || path.normalize(journalPath) !== journalPath
    || journalPath === path.parse(journalPath).root
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId)
    || !/^sha256:[a-f0-9]{64}$/u.test(authorityDigest)) {
    throw new TypeError("usage: simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>");
  }
  return { authority_digest: authorityDigest, journal_path: journalPath, run_id: runId };
};

/** Thin command seam for the exact recovery command emitted by recovery receipts. */
export const runComposedRecoveryCommand = async (input: Readonly<{
  argv: readonly string[];
  configuration: ComposedRunConfiguration;
  fault_injector?: ComposedRunFaultInjector;
  now?: () => string;
  ports: ComposedRunPorts;
}>): Promise<ComposedRunOutcome> => {
  const [command, ...args] = input.argv;
  const parsed = parseComposedRecoveryArguments(command === "recover" ? args : []);
  return recoverComposedRun({
    configuration: input.configuration,
    expected_authority: {
      authority_digest: parsed.authority_digest,
      run_id: parsed.run_id,
    },
    fault_injector: input.fault_injector,
    journal_path: parsed.journal_path,
    now: input.now,
    ports: input.ports,
  });
};
