#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ZodError } from "zod";

import { type BindingDiagnostic, type Simfile, createBindingDiagnostics, loadSpawnfileReport, parseSimfileSource } from "../schema/index.js";
import { type MoltnetArtifactKind, writeRunRecord } from "../runtime/trace.js";
import type { QueuedWorldAct } from "../runtime/types.js";
import { runViewCommand } from "../view/index.js";

const usage = (): string => [
  "Usage:",
  "  simfile validate <path> [--json] [--spawnfile-report <path>|<json>]",
  "  simfile run <path> --ticks <n> [--out <dir>] [--seed <seed>] [--run-id <id>] [--acts <path>] [--moltnet-artifact transcript|delivery] [--spawnfile-report <path>|<json>]",
  "  simfile view --state <path>",
  "  simfile view <run-record-dir>",
  "  simfile view --help",
  "  simfile --help",
  ""
].join("\n");

const formatError = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues.map((issue) =>
      `${issue.path.join(".") || "<root>"}: ${issue.message}`
    ).join("\n");
  }

  return error instanceof Error ? error.message : String(error);
};

interface ParsedRunOptions {
  actsPath?: string;
  moltnetArtifact?: MoltnetArtifactKind;
  outDir?: string;
  path?: string;
  runId?: string;
  seed?: string;
  ticks?: number;
  spawnfileReport?: string;
}

interface ParsedValidateOptions {
  json?: boolean;
  path?: string;
  spawnfileReport?: string;
}

const parseOptionalValueFlag = (
  arg: string,
  argv: readonly string[],
  index: number,
  flag: string,
  errorMessage: string
): { error?: string; value?: string; consumed: boolean } => {
  if (arg.startsWith(`${flag}=`)) {
    return { consumed: true, value: arg.slice(flag.length + 1) };
  }

  if (arg !== flag) {
    return { consumed: false };
  }

  const value = argv[index + 1];
  if (!value) {
    return { error: errorMessage, consumed: false };
  }
  return { consumed: true, value };
};

const parseValidateArguments = (argv: readonly string[]): {
  error?: string;
  options?: ParsedValidateOptions;
} => {
  const options: ParsedValidateOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const parsedReport = parseOptionalValueFlag(
      arg,
      argv,
      index,
      "--spawnfile-report",
      "Missing value for --spawnfile-report"
    );
    if (parsedReport.error) return { error: parsedReport.error };
    if (parsedReport.consumed) {
      options.spawnfileReport = parsedReport.value;
      if (arg === "--spawnfile-report") index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return { error: `Unknown flag ${arg}` };
    }
    if (options.path !== undefined) {
      return { error: `Unexpected positional argument ${arg}` };
    }
    options.path = arg;
  }

  if (!options.path) return { error: "Missing Simfile path" };
  return { options };
};

const parseRunArguments = (argv: readonly string[]): { error?: string; options?: ParsedRunOptions } => {
  const options: ParsedRunOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--ticks") {
      const value = argv[index + 1];
      if (!value) return { error: "Missing value for --ticks" };
      const ticks = Number(value);
      if (!Number.isInteger(ticks) || ticks < 0) return { error: "Invalid value for --ticks" };
      options.ticks = ticks;
      index += 1;
      continue;
    }

    if (arg.startsWith("--ticks=")) {
      const ticks = Number(arg.slice("--ticks=".length));
      if (!Number.isInteger(ticks) || ticks < 0) return { error: "Invalid value for --ticks" };
      options.ticks = ticks;
      continue;
    }

    if (arg === "--moltnet-artifact") {
      const value = argv[index + 1];
      if (value !== "delivery" && value !== "transcript") {
        return { error: "Invalid value for --moltnet-artifact" };
      }
      options.moltnetArtifact = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--moltnet-artifact=")) {
      const value = arg.slice("--moltnet-artifact=".length);
      if (value !== "delivery" && value !== "transcript") {
        return { error: "Invalid value for --moltnet-artifact" };
      }
      options.moltnetArtifact = value;
      continue;
    }

    if (arg === "--out" || arg === "--seed" || arg === "--run-id" || arg === "--acts") {
      const parsed = parseOptionalValueFlag(arg, argv, index, arg, `Missing value for ${arg}`);
      if (parsed.error) return { error: parsed.error };
      if (parsed.value === undefined) return { error: `Missing value for ${arg}` };
      if (arg === "--out") options.outDir = parsed.value;
      if (arg === "--seed") options.seed = parsed.value;
      if (arg === "--run-id") options.runId = parsed.value;
      if (arg === "--acts") options.actsPath = parsed.value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      options.outDir = arg.slice("--out=".length);
      continue;
    }

    if (arg.startsWith("--seed=")) {
      options.seed = arg.slice("--seed=".length);
      continue;
    }

    if (arg.startsWith("--run-id=")) {
      options.runId = arg.slice("--run-id=".length);
      continue;
    }

    if (arg.startsWith("--acts=")) {
      options.actsPath = arg.slice("--acts=".length);
      continue;
    }

    const parsedReport = parseOptionalValueFlag(
      arg,
      argv,
      index,
      "--spawnfile-report",
      "Missing value for --spawnfile-report"
    );
    if (parsedReport.error) return { error: parsedReport.error };
    if (parsedReport.consumed) {
      options.spawnfileReport = parsedReport.value;
      if (arg === "--spawnfile-report") index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return { error: `Unknown flag ${arg}` };
    }

    if (options.path !== undefined) {
      return { error: `Unexpected positional argument ${arg}` };
    }
    options.path = arg;
  }

  if (!options.path) return { error: "Missing Simfile path" };
  if (options.ticks === undefined) return { error: "Missing required --ticks" };
  return { options };
};

const defaultRunId = (seed: string): string => seed.replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run";

const toBindingDiagnostics = (warnings: string[]): BindingDiagnostic[] =>
  warnings.map((message) => ({ level: "warn", message }));

const bindingWarningsFromReport = async (
  simfile: Simfile,
  reportSource?: string
): Promise<BindingDiagnostic[]> => {
  if (!reportSource) {
    return [];
  }
  return createBindingDiagnostics(simfile, await loadSpawnfileReport(reportSource));
};

const hasErrorDiagnostic = (diagnostics: BindingDiagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.level === "error");

const loadQueuedWorldActs = async (actsPath?: string): Promise<QueuedWorldAct[] | undefined> => {
  if (!actsPath) {
    return undefined;
  }
  const raw = JSON.parse(await readFile(actsPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`--acts file must contain a JSON array: ${actsPath}`);
  }
  return raw as QueuedWorldAct[];
};

const printDiagnostics = (diagnostics: BindingDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.level === "error" ? "error" : "warning";
    process.stderr.write(`${prefix}: ${diagnostic.message}\n`);
  }
};

export const runCli = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(usage());
    return command === undefined ? 1 : 0;
  }

  if (command === "validate") {
    const parsed = parseValidateArguments(rest);
    if (parsed.error || !parsed.options?.path) {
      if (parsed.error) process.stderr.write(`${parsed.error}\n`);
      process.stderr.write(usage());
      return 1;
    }

    const path = parsed.options.path;
    try {
      const source = await readFile(path, "utf8");
      const result = parseSimfileSource(source, { path });
      const diagnostics = [
        ...toBindingDiagnostics(result.warnings),
        ...await bindingWarningsFromReport(result.simfile, parsed.options.spawnfileReport)
      ];
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify({
          diagnostics,
          ok: !hasErrorDiagnostic(diagnostics),
          path
        }, null, 2)}\n`);
      } else {
        printDiagnostics(diagnostics);
        if (hasErrorDiagnostic(diagnostics)) {
          process.stderr.write(`failed to validate ${path}\n`);
          return 1;
        }
        process.stdout.write(`validated ${path}\n`);
      }
      return hasErrorDiagnostic(diagnostics) ? 1 : 0;
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === "run") {
    const parsed = parseRunArguments(rest);
    if (parsed.error || !parsed.options?.path || parsed.options.ticks === undefined) {
      if (parsed.error) process.stderr.write(`${parsed.error}\n`);
      process.stderr.write(usage());
      return 1;
    }

    const path = parsed.options.path;
    try {
      const source = await readFile(path, "utf8");
      const result = parseSimfileSource(source, { path });
      const diagnostics = [
        ...toBindingDiagnostics(result.warnings),
        ...await bindingWarningsFromReport(result.simfile, parsed.options.spawnfileReport)
      ];
      printDiagnostics(diagnostics);
      if (hasErrorDiagnostic(diagnostics)) {
        process.stderr.write("failed to validate simulation before running\n");
        return 1;
      }

      const seed = parsed.options.seed ?? result.simfile.clock.seed;
      const runId = parsed.options.runId ?? defaultRunId(seed);
      const outDir = resolve(parsed.options.outDir ?? `runs/${runId}`);
      const worldActs = await loadQueuedWorldActs(parsed.options.actsPath);
      const record = await writeRunRecord({
        moltnetArtifact: parsed.options.moltnetArtifact,
        outDir,
        runId,
        seed,
        simfile: result.simfile,
        sourcePath: path,
        sourceText: source,
        ticks: parsed.options.ticks,
        worldActs
      });
      process.stdout.write(`wrote run ${runId} to ${record.outDir}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === "view") {
    return runViewCommand(rest);
  }

  if (command !== "validate" || !rest.length) {
    process.stderr.write(usage());
    return 1;
  }

  process.stderr.write(usage());
  return 1;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli(process.argv.slice(2));
}
