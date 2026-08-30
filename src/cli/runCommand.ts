import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { executeSimfileRun } from "../run/run-driver.js";
import { parseSimfileSource } from "../schema/index.js";
import { runLinkedComposedCommand, type LinkedComposedRunCommand } from
  "./composedRunCommand.js";
import {
  bindingDiagnostics,
  formatCliError,
  hasErrorDiagnostic,
  printDiagnostics,
  simfileCliUsage,
} from "./cliShared.js";
import { parseRunArguments } from "./runArguments.js";
import { resolveSimfileRunRoute } from "./runRoute.js";

const defaultRunId = (seed: string): string => seed.replace(/[^a-zA-Z0-9_.-]+/gu, "-")
  .replace(/^-+|-+$/gu, "") || "run";

export const runSimfileCommand = async (
  argv: readonly string[],
  dependencies: Readonly<{ runComposed?: LinkedComposedRunCommand }>,
): Promise<number> => {
  let options;
  try { options = parseRunArguments(argv); }
  catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.stderr.write(simfileCliUsage());
    return 1;
  }
  const simfilePath = options.path;
  try {
    const source = await readFile(simfilePath, "utf8");
    const result = parseSimfileSource(source, { path: simfilePath });
    const route = resolveSimfileRunRoute({ options, simfile: result.simfile, simfilePath });
    const diagnostics = await bindingDiagnostics(
      result.simfile, result.warnings, options.spawnfileReport,
    );
    printDiagnostics(diagnostics);
    if (hasErrorDiagnostic(diagnostics)) {
      process.stderr.write("failed to validate simulation before running\n");
      return 1;
    }
    if (route.kind === "composed") {
      return await (dependencies.runComposed ?? runLinkedComposedCommand)({
        linked_spawnfile_path: route.linked_spawnfile_path,
        options, simfile: result.simfile, simfile_path: simfilePath, source_text: source,
      });
    }
    const seed = options.seed ?? result.simfile.clock.seed;
    const runId = options.runId ?? defaultRunId(seed);
    const clock = options.clock;
    const run = await executeSimfileRun({
      actsPath: options.actsPath,
      clock: clock === undefined ? () => new Date() : () => new Date(clock),
      moltnetArtifact: options.moltnetArtifact,
      outDir: resolve(options.outDir ?? `runs/${runId}`),
      runId, seed, simfile: result.simfile, simfilePath, sourceText: source,
      ticks: options.ticks!,
    });
    process.stdout.write(`wrote run ${runId} to ${run.outDir}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
};
