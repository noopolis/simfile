#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { ZodError } from "zod";

import { parseSimfileSource } from "../schema/index.js";

const usage = (): string => [
  "Usage:",
  "  simfile validate <path>",
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

export const runCli = async (argv: readonly string[]): Promise<number> => {
  const [command, path] = argv;

  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(usage());
    return command === undefined ? 1 : 0;
  }

  if (command !== "validate" || !path) {
    process.stderr.write(usage());
    return 1;
  }

  try {
    const source = await readFile(path, "utf8");
    const result = parseSimfileSource(source, { path });
    process.stdout.write(`validated ${path}\n`);
    for (const warning of result.warnings) {
      process.stderr.write(`warning: ${warning}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli(process.argv.slice(2));
}
