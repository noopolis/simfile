import { readFile } from "node:fs/promises";

import { parseSimfileSource } from "../schema/index.js";
import {
  bindingDiagnostics,
  formatCliError,
  hasErrorDiagnostic,
  printDiagnostics,
  simfileCliUsage,
} from "./cliShared.js";

interface ParsedValidateOptions {
  json?: boolean;
  path?: string;
  spawnfileReport?: string;
}

const parseValidateArguments = (argv: readonly string[]): {
  error?: string;
  options?: ParsedValidateOptions;
} => {
  const options: ParsedValidateOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--spawnfile-report" || arg.startsWith("--spawnfile-report=")) {
      const value = arg === "--spawnfile-report" ? argv[++index]
        : arg.slice("--spawnfile-report=".length);
      if (!value) return { error: "Missing value for --spawnfile-report" };
      options.spawnfileReport = value;
      continue;
    }
    if (arg.startsWith("-")) return { error: `Unknown flag ${arg}` };
    if (options.path !== undefined) return { error: `Unexpected positional argument ${arg}` };
    options.path = arg;
  }
  return options.path === undefined ? { error: "Missing Simfile path" } : { options };
};

export const runValidateCommand = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseValidateArguments(argv);
  if (parsed.error || !parsed.options?.path) {
    if (parsed.error) process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(simfileCliUsage());
    return 1;
  }
  const path = parsed.options.path;
  try {
    const result = parseSimfileSource(await readFile(path, "utf8"), { path });
    const diagnostics = await bindingDiagnostics(
      result.simfile, result.warnings, parsed.options.spawnfileReport,
    );
    const ok = !hasErrorDiagnostic(diagnostics);
    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify({ diagnostics, ok, path }, null, 2)}\n`);
    } else {
      printDiagnostics(diagnostics);
      if (!ok) process.stderr.write(`failed to validate ${path}\n`);
      else process.stdout.write(`validated ${path}\n`);
    }
    return ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
};
