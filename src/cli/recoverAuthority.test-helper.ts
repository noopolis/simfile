import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createComposedPhaseJournal } from "../compose/journal.js";
import type { ComposedPhaseJournal } from "../compose/journal.js";
import { parseComposedExecution } from "../compose/execution.js";
import { digestComposedJson } from "../compose/json.js";
import type { ComposedRunRequest } from "../compose/request.js";

const execute = promisify(execFile);

export interface BuiltRecovery { readonly recovery_command: string; readonly status: string }

export const failedBuiltRecovery = async (input: Readonly<{
  authorityDigest: string;
  cliPath: string;
  cwd: string;
  journalPath: string;
  runId: string;
}>): Promise<BuiltRecovery> => {
  try {
    await execute(process.execPath, [input.cliPath, "recover", "--journal", input.journalPath,
      "--run-id", input.runId, "--authority-digest", input.authorityDigest], {
      cwd: input.cwd, timeout: 10_000,
    });
    assert.fail("crash-window recovery unexpectedly completed");
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    return JSON.parse(failure.stdout ?? "") as BuiltRecovery;
  }
};

export const builtRecoveryEffectCount = async (
  effectState: string,
  command: string,
): Promise<number> => {
  const effects = await readFile(effectState, "utf8")
    .then((value) => JSON.parse(value) as Record<string, number>).catch(() => ({}));
  return Object.keys(effects).filter((key) => key.startsWith(`${command}:`)).length;
};

export const builtRecoveryProviderCommand = (call: string[]): string => call[0] === "target"
  ? call[3]! : call[0] === "artifacts" ? "artifacts_export" : call[0]!;

export const organizationExport = (runId: string) => ({
  deployment: "organization-unit", failed_files: [],
  index: {
    deployment: "organization-unit", exported_at: "2026-01-01T00:00:14.000Z",
    files: [
      { bytes: 1, path: "raw/daimon/member/log.jsonl", sha256: "a".repeat(64), source: { kind: "volume", ref: "d:/log" } },
      { bytes: 1, path: "raw/mneme/bank/log.jsonl", sha256: "b".repeat(64), source: { kind: "volume", ref: "m:/log" } },
      { bytes: 1, path: "raw/moltnet/log.jsonl", sha256: "c".repeat(64), source: { kind: "volume", ref: "n:/log" } },
    ],
    run_id: runId, version: "spawnfile.export-index.v1",
  },
  index_path: "/evidence/spawnfile/export-index.json", missing_optional_files: [],
});

export const createForeignExecutionJournal = (
  request: ComposedRunRequest,
  recordedAt: string,
  rawExecution: unknown,
) => {
  const execution = parseComposedExecution(rawExecution);
  return createComposedPhaseJournal(request, recordedAt, {
    ...execution,
    configuration: {
      ...execution.configuration,
      readiness_expectation: {
        ...execution.configuration.readiness_expectation,
        run_id: request.run_id,
      },
    },
  });
};

export const expectBuiltRecoveryAuthorityFailure = async (input: Readonly<{
  authorityDigest: string;
  cliPath: string;
  cwd: string;
  journalPath: string;
  runId: string;
}>): Promise<void> => {
  try {
    await execute(process.execPath, [input.cliPath, "recover", "--journal", input.journalPath,
      "--run-id", input.runId, "--authority-digest", input.authorityDigest], {
      cwd: input.cwd,
      timeout: 10_000,
    });
    assert.fail("journal authority loss unexpectedly emitted a recovery receipt");
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr ?? "",
      /^composed journal (?:authority changed|file (?:identity changed|is unsafe))\n$/u);
    assert.ok((failure.stderr ?? "").length < 128);
    assert.doesNotMatch(failure.stderr ?? "", /recover --journal|recovery_command|run-foreign/u);
  }
};

const optionalBytes = async (file: string): Promise<string> =>
  readFile(file, "utf8").catch(() => "");

export const expectBuiltForeignJournalRejections = async (input: Readonly<{
  authorityDigest: string;
  cliPath: string;
  cwd: string;
  foreignJournals: readonly ComposedPhaseJournal[];
  foreignPath: string;
  journalPath: string;
  providerLogs: readonly string[];
  runId: string;
}>): Promise<void> => {
  const owned = await readFile(input.journalPath);
  for (const [index, journal] of input.foreignJournals.entries()) {
    await writeFile(input.foreignPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    const foreignBytes = await readFile(input.foreignPath, "utf8");
    const logsBefore = await Promise.all(input.providerLogs.map(optionalBytes));
    await rename(input.foreignPath, input.journalPath);
    const reject = () => expectBuiltRecoveryAuthorityFailure({
      authorityDigest: input.authorityDigest,
      cliPath: input.cliPath,
      cwd: input.cwd,
      journalPath: input.journalPath,
      runId: input.runId,
    });
    if (index === 0) {
      await Promise.all([reject(), reject()]);
      await reject();
    } else await reject();
    assert.equal(await readFile(input.journalPath, "utf8"), foreignBytes);
    assert.deepEqual(await Promise.all(input.providerLogs.map(optionalBytes)), logsBefore);
    await rm(input.journalPath, { force: true });
    await writeFile(input.journalPath, owned, { mode: 0o600 });
  }
};

export const expectBuiltRecoveryArgumentRejections = async (input: Readonly<{
  authorityDigest: string;
  cliPath: string;
  cwd: string;
  journalPath: string;
  providerLogs: readonly string[];
  runId: string;
}>): Promise<void> => {
  const base = [input.cliPath, "recover", "--journal", input.journalPath,
    "--run-id", input.runId, "--authority-digest", input.authorityDigest];
  const logsBefore = await Promise.all(input.providerLogs.map(optionalBytes));
  for (const argv of [
    base.slice(0, 4),
    [...base, "--run-id", input.runId],
    [...base, "--unknown", "value"],
  ]) {
    try {
      await execute(process.execPath, argv, { cwd: input.cwd, timeout: 10_000 });
      assert.fail("invalid recovery arguments unexpectedly ran");
    } catch (error) {
      const failure = error as { code?: number; stderr?: string; stdout?: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.equal(failure.stderr,
        "usage: simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>\n");
    }
  }
  assert.deepEqual(await Promise.all(input.providerLogs.map(optionalBytes)), logsBefore);
};

export const expectBuiltRecoveryFileRejections = async (input: Readonly<{
  authorityDigest: string;
  cliPath: string;
  cwd: string;
  journalPath: string;
  logPath: string;
  root: string;
  runId: string;
}>): Promise<void> => {
  const callsBefore = (await readFile(input.logPath, "utf8")).trim().split("\n").length;
  const rejectJournal = async (candidate: string): Promise<void> => {
    await assert.rejects(execute(process.execPath, [
      input.cliPath, "recover", "--journal", candidate, "--run-id", input.runId,
      "--authority-digest", input.authorityDigest,
    ], { cwd: input.cwd, timeout: 5_000 }), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      return failure.code === 1 && failure.stdout === "";
    });
  };
  await rejectJournal(path.join(input.root, "missing.json"));
  const malformed = path.join(input.root, "malformed.json");
  await writeFile(malformed, "{\n");
  await rejectJournal(malformed);
  const secret = path.join(input.root, "secret.json");
  await writeFile(secret, '{"token":"token=must-not-load"}\n');
  await rejectJournal(secret);
  const crossed = path.join(input.root, "crossed.json");
  const crossRun = JSON.parse(await readFile(input.journalPath, "utf8")) as Record<string, unknown>;
  const crossExecution = crossRun.execution as {
    configuration: { readiness_expectation: { run_id: string } };
  };
  crossExecution.configuration.readiness_expectation.run_id = "run-foreign";
  const { journal_digest: _oldDigest, ...crossBody } = crossRun;
  crossRun.journal_digest = digestComposedJson("simfile.composed-phase-journal.v1", crossBody);
  await writeFile(crossed, `${JSON.stringify(crossRun)}\n`);
  await rejectJournal(crossed);
  assert.equal((await readFile(input.logPath, "utf8")).trim().split("\n").length, callsBefore);
};
