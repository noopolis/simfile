#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZodError } from "zod";

import { executeSimfileRun } from "../run/run-driver.js";
import { type BindingDiagnostic, type Simfile, createBindingDiagnostics, loadSpawnfileReport, parseSimfileSource } from "../schema/index.js";
import { runObserveCommand } from "../observe/observeCommand.js";
import { runViewCommand } from "../view/index.js";
import { runLinkedComposedCommand, type LinkedComposedRunCommand } from "./composedRunCommand.js";
import { runRecoverCli } from "./recover.js";
import { parseRunArguments } from "./runArguments.js";
import { resolveSimfileRunRoute } from "./runRoute.js";

const usage = (): string => [
  "Usage:",
  "  simfile validate <path> [--json] [--spawnfile-report <path>|<json>]",
  "  simfile run <path> [--view] [--out <dir>] [--seed <seed>] [--run-id <id>]",
  "  simfile run <path> --local --ticks <n> [--out <dir>] [--seed <seed>] [--run-id <id>] [--acts <path>] [--clock <iso>] [--moltnet-artifact transcript|delivery] [--spawnfile-report <path>|<json>]",
  "  simfile observe <run-dir> [--json]",
  "  simfile view --state <path>",
  "  simfile view <run-record-dir>",
  "  simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>",
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

const printDiagnostics = (diagnostics: BindingDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.level === "error" ? "error" : "warning";
    process.stderr.write(`${prefix}: ${diagnostic.message}\n`);
  }
};

export const runCli = async (
  argv: readonly string[],
  dependencies: Readonly<{ runComposed?: LinkedComposedRunCommand }> = {},
): Promise<number> => {
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
    let options;
    try {
      options = parseRunArguments(rest);
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      process.stderr.write(usage());
      return 1;
    }
    const simfilePath = options.path;
    try {
      const source = await readFile(simfilePath, "utf8");
      const result = parseSimfileSource(source, { path: simfilePath });
      const route = resolveSimfileRunRoute({ options, simfile: result.simfile, simfilePath });
      const diagnostics = [
        ...toBindingDiagnostics(result.warnings),
        ...await bindingWarningsFromReport(result.simfile, options.spawnfileReport)
      ];
      printDiagnostics(diagnostics);
      if (hasErrorDiagnostic(diagnostics)) {
        process.stderr.write("failed to validate simulation before running\n");
        return 1;
      }
      if (route.kind === "composed") {
        return (dependencies.runComposed ?? runLinkedComposedCommand)({
          linked_spawnfile_path: route.linked_spawnfile_path,
          options,
          simfile: result.simfile,
          simfile_path: simfilePath,
          source_text: source,
        });
      }
      const seed = options.seed ?? result.simfile.clock.seed;
      const runId = options.runId ?? defaultRunId(seed);
      const outDir = resolve(options.outDir ?? `runs/${runId}`);
      const clock = options.clock;
      const run = await executeSimfileRun({
        actsPath: options.actsPath,
        clock: clock === undefined ? () => new Date() : () => new Date(clock),
        moltnetArtifact: options.moltnetArtifact,
        outDir,
        runId,
        seed,
        simfile: result.simfile,
        simfilePath,
        sourceText: source,
        ticks: options.ticks!
      });
      process.stdout.write(`wrote run ${runId} to ${run.outDir}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === "recover") {
    try {
      return await runRecoverCli(rest);
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  if (command === "observe") {
    return runObserveCommand(rest, { formatError, usage });
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

export const isCliEntrypoint = (moduleUrl: string, argvPath: string | undefined): boolean => {
  if (argvPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
};

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
