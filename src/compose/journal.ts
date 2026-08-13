import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  assertSecretFreeComposedJson,
  canonicalComposedJson,
  digestComposedJson,
} from "./json.js";
import {
  composedRunRequestSchema,
  createComposedRunRequestDigest,
  parseComposedRunRequest,
  type ComposedRunRequest,
} from "./request.js";
import {
  COMPOSED_EXECUTION_VERSION,
  composedExecutionSchema,
  parseComposedExecution,
  type ComposedExecution,
} from "./execution.js";
import {
  COMPOSED_RUN_PHASES,
  composedRunPhaseIndex,
  nextComposedRunPhase,
  type ComposedRunPhase,
} from "./types.js";

export const COMPOSED_PHASE_JOURNAL_VERSION = "simfile.composed-phase-journal.v1" as const;
export const COMPOSED_JOURNAL_AUTHORITY_VERSION = "simfile.composed-journal-authority.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const payload = z.record(z.string(), z.unknown());
const entry = z.object({
  payload,
  payload_digest: digest,
  phase: z.enum(COMPOSED_RUN_PHASES),
  recorded_at: timestamp,
  sequence: z.number().int().min(0).max(COMPOSED_RUN_PHASES.length - 1),
}).strict();

export const composedPhaseJournalSchema = z.object({
  authority_digest: digest,
  current_phase: z.enum(COMPOSED_RUN_PHASES),
  entries: z.array(entry).min(1).max(COMPOSED_RUN_PHASES.length),
  execution: composedExecutionSchema.optional(),
  genesis_nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  interruption: z.object({
    next_phase: z.enum(COMPOSED_RUN_PHASES),
    recovery_command: z.string().min(1).max(8_192),
    signal: z.enum(["SIGINT", "SIGTERM", "restart", "failure"]),
  }).strict().nullable(),
  journal_digest: digest,
  request: composedRunRequestSchema,
  request_digest: digest,
  state: z.enum(["active", "recoverable", "complete"]),
  version: z.literal(COMPOSED_PHASE_JOURNAL_VERSION),
}).strict();

export type ComposedPhaseJournal = z.infer<typeof composedPhaseJournalSchema>;

const payloadDigest = (phase: ComposedRunPhase, value: unknown): `sha256:${string}` =>
  digestComposedJson(`simfile.composed-phase.${phase}.v1`, value);

const parseTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("composed journal timestamp is invalid");
  return parsed;
};

const authorityDigest = (input: Readonly<{
  execution?: ComposedExecution;
  genesis_nonce: string;
  recorded_at: string;
  request_digest: string;
}>): `sha256:${string}` => digestComposedJson(COMPOSED_JOURNAL_AUTHORITY_VERSION, {
  execution_digest: input.execution === undefined ? null
    : digestComposedJson(COMPOSED_EXECUTION_VERSION, input.execution),
  genesis_nonce: input.genesis_nonce,
  recorded_at: input.recorded_at,
  request_digest: input.request_digest,
});

export const parseComposedPhaseJournal = (raw: unknown): ComposedPhaseJournal => {
  assertSecretFreeComposedJson(raw);
  const journal = composedPhaseJournalSchema.parse(raw);
  const execution = journal.execution === undefined
    ? undefined
    : parseComposedExecution(journal.execution);
  const expectedAuthority = authorityDigest({
    ...(execution === undefined ? {} : { execution }),
    genesis_nonce: journal.genesis_nonce,
    recorded_at: journal.entries[0]!.recorded_at,
    request_digest: journal.request_digest,
  });
  if (journal.request_digest !== createComposedRunRequestDigest(journal.request)
    || journal.authority_digest !== expectedAuthority
    || journal.entries.length !== composedRunPhaseIndex(journal.current_phase) + 1
    || (execution !== undefined
      && execution.provider.target_config_producer.args[0] !== journal.request.target.selector)
    || (execution !== undefined
      && execution.configuration.readiness_expectation.run_id !== journal.request.run_id)
    || (execution !== undefined
      && execution.configuration.readiness_expectation.bundle_digest
        !== journal.request.world.bundle_digest)
    || (execution !== undefined
      && execution.configuration.organization_expectation.world_binding_digest
        !== journal.request.organization.world_bindings_digest)) {
    throw new TypeError("composed journal correlation is invalid");
  }
  let previousTime = -Infinity;
  for (const [index, phaseEntry] of journal.entries.entries()) {
    assertSecretFreeComposedJson(phaseEntry.payload);
    if (phaseEntry.phase !== COMPOSED_RUN_PHASES[index]
      || phaseEntry.sequence !== index
      || phaseEntry.payload.run_id !== journal.request.run_id
      || phaseEntry.payload_digest !== payloadDigest(phaseEntry.phase, phaseEntry.payload)) {
      throw new TypeError("composed journal transition is invalid");
    }
    const currentTime = parseTimestamp(phaseEntry.recorded_at);
    if (currentTime < previousTime) throw new TypeError("composed journal time regressed");
    previousTime = currentTime;
  }
  if ((journal.state === "complete") !== (journal.current_phase === "completed")
    || (journal.state === "recoverable") !== (journal.interruption !== null)) {
    throw new TypeError("composed journal state is contradictory");
  }
  if (journal.interruption !== null
    && journal.interruption.next_phase !== nextComposedRunPhase(journal.current_phase)) {
    throw new TypeError("composed journal recovery phase is invalid");
  }
  const { journal_digest: _journalDigest, ...body } = journal;
  if (journal.journal_digest !== digestComposedJson(COMPOSED_PHASE_JOURNAL_VERSION, body)) {
    throw new TypeError("composed journal digest is invalid");
  }
  return Object.freeze(journal);
};

const seal = (
  body: Omit<ComposedPhaseJournal, "journal_digest">,
): ComposedPhaseJournal => parseComposedPhaseJournal({
  ...body,
  journal_digest: digestComposedJson(COMPOSED_PHASE_JOURNAL_VERSION, body),
});

const phaseEntry = (
  phase: ComposedRunPhase,
  value: Record<string, unknown>,
  recordedAt: string,
) => ({
  payload: value,
  payload_digest: payloadDigest(phase, value),
  phase,
  recorded_at: timestamp.parse(recordedAt),
  sequence: composedRunPhaseIndex(phase),
});

export const createComposedPhaseJournal = (
  rawRequest: unknown,
  recordedAt: string,
  rawExecution?: unknown,
): ComposedPhaseJournal => {
  const request = parseComposedRunRequest(rawRequest);
  const execution = rawExecution === undefined ? undefined : parseComposedExecution(rawExecution);
  const initial = phaseEntry("requested", {
    request_digest: createComposedRunRequestDigest(request),
    run_id: request.run_id,
  }, recordedAt);
  const genesisNonce = randomBytes(32).toString("hex");
  const authority = authorityDigest({
    ...(execution === undefined ? {} : { execution }),
    genesis_nonce: genesisNonce,
    recorded_at: initial.recorded_at,
    request_digest: createComposedRunRequestDigest(request),
  });
  return seal({
    authority_digest: authority,
    current_phase: "requested",
    entries: [initial],
    ...(execution === undefined ? {} : { execution }),
    genesis_nonce: genesisNonce,
    interruption: null,
    request,
    request_digest: createComposedRunRequestDigest(request),
    state: "active",
    version: COMPOSED_PHASE_JOURNAL_VERSION,
  });
};

export const appendComposedPhase = (
  rawJournal: unknown,
  phase: ComposedRunPhase,
  rawPayload: Record<string, unknown>,
  recordedAt: string,
): ComposedPhaseJournal => {
  const journal = parseComposedPhaseJournal(rawJournal);
  assertSecretFreeComposedJson(rawPayload);
  if (rawPayload.run_id !== journal.request.run_id) {
    throw new TypeError("composed phase run correlation is invalid");
  }
  const requestedIndex = composedRunPhaseIndex(phase);
  const currentIndex = composedRunPhaseIndex(journal.current_phase);
  if (requestedIndex <= currentIndex) {
    const existing = journal.entries[requestedIndex];
    if (!existing || existing.payload_digest !== payloadDigest(phase, rawPayload)) {
      throw new TypeError("composed phase replay is contradictory");
    }
    return journal;
  }
  if (requestedIndex !== currentIndex + 1 || journal.state === "complete") {
    throw new TypeError("composed phase transition is not monotonic");
  }
  const entries = [...journal.entries, phaseEntry(phase, rawPayload, recordedAt)];
  return seal({
    authority_digest: journal.authority_digest,
    current_phase: phase,
    entries,
    ...(journal.execution === undefined ? {} : { execution: journal.execution }),
    genesis_nonce: journal.genesis_nonce,
    interruption: null,
    request: journal.request,
    request_digest: journal.request_digest,
    state: phase === "completed" ? "complete" : "active",
    version: COMPOSED_PHASE_JOURNAL_VERSION,
  });
};

export const markComposedJournalRecoverable = (
  rawJournal: unknown,
  input: Readonly<{
    recovery_command: string;
    signal: "SIGINT" | "SIGTERM" | "restart" | "failure";
  }>,
): ComposedPhaseJournal => {
  const journal = parseComposedPhaseJournal(rawJournal);
  const nextPhase = nextComposedRunPhase(journal.current_phase);
  if (nextPhase === null || journal.state === "complete") {
    throw new TypeError("completed journal cannot require recovery");
  }
  return seal({
    authority_digest: journal.authority_digest,
    current_phase: journal.current_phase,
    entries: journal.entries,
    ...(journal.execution === undefined ? {} : { execution: journal.execution }),
    genesis_nonce: journal.genesis_nonce,
    interruption: {
      next_phase: nextPhase,
      recovery_command: input.recovery_command,
      signal: input.signal,
    },
    request: journal.request,
    request_digest: journal.request_digest,
    state: "recoverable",
    version: COMPOSED_PHASE_JOURNAL_VERSION,
  });
};

const exactJournalPath = (value: string): string => {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || value === path.parse(value).root || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("composed journal path is invalid");
  }
  return value;
};

export const writeComposedPhaseJournal = async (
  journalPath: string,
  rawJournal: unknown,
): Promise<void> => {
  const target = exactJournalPath(journalPath);
  const journal = parseComposedPhaseJournal(rawJournal);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${target}.${process.pid}.${randomUUID()}.pending`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalComposedJson(journal)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

export const readComposedPhaseJournal = async (
  journalPath: string,
): Promise<ComposedPhaseJournal> => parseComposedPhaseJournal(
  JSON.parse(await readFile(exactJournalPath(journalPath), "utf8")) as unknown,
);
