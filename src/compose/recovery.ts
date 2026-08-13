import path from "node:path";

import {
  createComposedPhaseJournal,
  markComposedJournalRecoverable,
  type ComposedPhaseJournal,
} from "./journal.js";
import {
  createComposedJournalSession,
  openComposedJournalSession,
  type ComposedJournalAuthorityExpectation,
  type ComposedJournalSession,
} from "./journalSession.js";
import { composedPhaseReached } from "./phase.js";
import {
  composedRecoveryCommand,
  createComposedRecoveryReceipt,
  type ComposedRecoveryReceipt,
} from "./receipt.js";
import {
  executeComposedRun,
  completedComposedRunFromJournal,
  type CompletedComposedRun,
  type ComposedRunConfiguration,
  type ComposedRunPorts,
} from "./run.js";
import {
  createComposedRunRequestDigest,
  type ComposedRunRequest,
} from "./request.js";
import type { ComposedRunFaultInjector } from "./types.js";
import type { ComposedExecution } from "./execution.js";

export type ComposedInterruptionSignal = "SIGINT" | "SIGTERM";

export class ComposedRunInterruption extends Error {
  readonly signal: ComposedInterruptionSignal;

  constructor(signal: ComposedInterruptionSignal) {
    super(`composed run interrupted by ${signal}`);
    this.name = "ComposedRunInterruption";
    this.signal = signal;
  }
}

export interface RecoverableComposedRun {
  readonly journal: ComposedPhaseJournal;
  readonly receipt: ComposedRecoveryReceipt;
}

export type ComposedRunOutcome = CompletedComposedRun | RecoverableComposedRun;

export interface DurableComposedRunInput {
  readonly configuration: ComposedRunConfiguration;
  readonly execution?: ComposedExecution;
  readonly expected_authority?: ComposedJournalAuthorityExpectation;
  readonly fault_injector?: ComposedRunFaultInjector;
  readonly journal_path: string;
  readonly journal_session?: ComposedJournalSession;
  readonly now?: () => string;
  readonly ports: ComposedRunPorts;
  readonly request?: ComposedRunRequest;
}

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const sameAuthority = (
  journal: ComposedPhaseJournal,
  expected: ComposedJournalAuthorityExpectation,
): boolean => journal.authority_digest === expected.authority_digest
  && journal.request.run_id === expected.run_id;

const loadOrCreate = async (
  input: DurableComposedRunInput,
  now: () => string,
): Promise<{ created: boolean; journal: ComposedPhaseJournal; session: ComposedJournalSession }> => {
  if (input.journal_session !== undefined) {
    if (input.journal_session.path !== input.journal_path) {
      throw new TypeError("composed journal session path changed");
    }
    await input.journal_session.assertCurrent();
    const journal = input.journal_session.current();
    if (input.expected_authority !== undefined
      && !sameAuthority(journal, input.expected_authority)) {
      throw new TypeError("composed journal authority changed");
    }
    if (input.request !== undefined
      && journal.request_digest !== createComposedRunRequestDigest(input.request)) {
      throw new TypeError("durable composed request changed");
    }
    return { created: false, journal, session: input.journal_session };
  }
  if (input.expected_authority === undefined) {
    if (input.request === undefined) {
      throw new TypeError("composed journal authority expectation is unavailable");
    }
    const journal = createComposedPhaseJournal(input.request, now(), input.execution);
    const session = await createComposedJournalSession(input.journal_path, journal);
    return { created: true, journal, session };
  }
  try {
    const session = await openComposedJournalSession(
      input.journal_path, input.expected_authority,
    );
    const journal = session.current();
    if (input.request !== undefined
      && journal.request_digest !== createComposedRunRequestDigest(input.request)) {
      throw new TypeError("durable composed request changed");
    }
    return { created: false, journal, session };
  } catch (error) {
    if (!missing(error)) throw error;
    throw new TypeError("composed recovery journal is unavailable");
  }
};

/** Runs durably and converts signals/failures into one exact recovery receipt. */
export const runDurableComposedRun = async (
  input: DurableComposedRunInput,
): Promise<ComposedRunOutcome> => {
  const now = input.now ?? (() => new Date().toISOString());
  let pendingSignal: ComposedInterruptionSignal | undefined;
  const controller = new AbortController();
  const interrupt = (signal: ComposedInterruptionSignal): void => {
    pendingSignal ??= signal;
    if (!controller.signal.aborted) controller.abort(new ComposedRunInterruption(signal));
  };
  const onSigint = (): void => { interrupt("SIGINT"); };
  const onSigterm = (): void => { interrupt("SIGTERM"); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let latest: ComposedPhaseJournal | undefined;
  let session: ComposedJournalSession | undefined;
  try {
    const loaded = await loadOrCreate(input, now);
    session = loaded.session;
    latest = loaded.journal;
    const boundary = async (phase: Parameters<NonNullable<ComposedRunFaultInjector["afterPhase"]>>[0]) => {
      await input.fault_injector?.afterPhase?.(phase);
      if (pendingSignal) throw new ComposedRunInterruption(pendingSignal);
    };
    if (loaded.created) await boundary("requested");
    return await executeComposedRun({
      configuration: input.configuration,
      context: {
        fault_injector: { afterPhase: boundary },
        now,
        persist: async (journal) => {
          await loaded.session.replace(latest!, journal);
          latest = journal;
        },
      },
      journal: latest,
      ports: input.ports,
      signal: controller.signal,
    });
  } catch (error) {
    if (latest === undefined) throw error;
    if (latest.current_phase === "completed") return completedComposedRunFromJournal(latest);
    const signal = error instanceof ComposedRunInterruption
      ? error.signal
      : pendingSignal ?? "failure";
    const recoverable = markComposedJournalRecoverable(latest, {
      recovery_command: composedRecoveryCommand(
        input.journal_path, latest.request.run_id, latest.authority_digest,
      ),
      signal,
    });
    if (session === undefined) throw error;
    await session.replace(latest, recoverable);
    latest = recoverable;
    const interruption = recoverable.interruption;
    if (interruption === null) throw new TypeError("composed recovery state is unavailable");
    return {
      journal: recoverable,
      receipt: createComposedRecoveryReceipt({
        authority_digest: recoverable.authority_digest,
        journal_digest: recoverable.journal_digest,
        journal_path: input.journal_path,
        next_phase: interruption.next_phase,
        preserved_evidence: composedPhaseReached(recoverable, "world_evidence_exported"),
        run_id: recoverable.request.run_id,
        signal,
      }),
    };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
};

/** Implements the exact authority-bound `simfile recover` semantic operation. */
export const recoverComposedRun = async (
  input: Omit<DurableComposedRunInput, "expected_authority" | "request"> & {
    readonly expected_authority: ComposedJournalAuthorityExpectation;
  },
): Promise<ComposedRunOutcome> => runDurableComposedRun(input);

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
