import { resolve } from "node:path";

import { runObserve, writeObserveReport } from "./observe.js";
import { observeSummaryLines } from "./summaryLines.js";

export interface ObserveCommandHelpers {
  formatError: (error: unknown) => string;
  usage: () => string;
}

interface ParsedObserveOptions {
  json?: boolean;
  runDir?: string;
}

const parseObserveArguments = (argv: readonly string[]): { error?: string; options?: ParsedObserveOptions } => {
  const options: ParsedObserveOptions = {};

  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `Unknown flag ${arg}` };
    }
    if (options.runDir !== undefined) {
      return { error: `Unexpected positional argument ${arg}` };
    }
    options.runDir = arg;
  }

  if (!options.runDir) return { error: "Missing run directory" };
  return { options };
};

export const runObserveCommand = async (
  argv: readonly string[],
  helpers: ObserveCommandHelpers
): Promise<number> => {
  const parsed = parseObserveArguments(argv);
  if (parsed.error || !parsed.options?.runDir) {
    if (parsed.error) process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(helpers.usage());
    return 1;
  }

  const runDir = resolve(parsed.options.runDir);
  try {
    const result = await runObserve(runDir);
    const reportPath = await writeObserveReport(runDir, result.report);

    const failedArtifacts = result.artifactIntegrity.filter((check) => !check.ok);
    for (const failed of failedArtifacts) {
      process.stderr.write(
        `warning: artifact sha256 mismatch for ${failed.path} (expected ${failed.expectedSha256}, got ${failed.actualSha256 ?? "<missing>"})\n`
      );
    }
    for (const parseError of result.causalParseErrors) {
      process.stderr.write(`warning: ${parseError.relativePath}:${parseError.line}: ${parseError.message}\n`);
    }

    if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify({
        artifactIntegrity: result.artifactIntegrity,
        causalParseErrors: result.causalParseErrors,
        report: result.report,
        reportPath
      }, null, 2)}\n`);
    } else {
      for (const line of observeSummaryLines(result.report, reportPath)) {
        process.stdout.write(`${line}\n`);
      }
    }
    return failedArtifacts.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${helpers.formatError(error)}\n`);
    return 1;
  }
};
