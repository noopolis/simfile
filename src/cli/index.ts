#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runObserveCommand } from "../observe/observeCommand.js";
import { runViewCommand } from "../view/index.js";
import type { LinkedComposedRunCommand } from "./composedRunCommand.js";
import { formatCliError, simfileCliUsage } from "./cliShared.js";
import { runRecoverCli } from "./recover.js";
import { runSimfileCommand } from "./runCommand.js";
import { runValidateCommand } from "./validateCommand.js";

export const runCli = async (
  argv: readonly string[],
  dependencies: Readonly<{ runComposed?: LinkedComposedRunCommand }> = {},
): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(simfileCliUsage());
    return command === undefined ? 1 : 0;
  }
  if (command === "validate") return runValidateCommand(rest);
  if (command === "run") return runSimfileCommand(rest, dependencies);
  if (command === "recover") {
    try { return await runRecoverCli(rest); }
    catch (error) {
      process.stderr.write(`${formatCliError(error)}\n`);
      return 1;
    }
  }
  if (command === "observe") {
    return runObserveCommand(rest, { formatError: formatCliError, usage: simfileCliUsage });
  }
  if (command === "view") return runViewCommand(rest);
  process.stderr.write(simfileCliUsage());
  return 1;
};

export const isCliEntrypoint = (moduleUrl: string, argvPath: string | undefined): boolean => {
  if (argvPath === undefined) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
};

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
