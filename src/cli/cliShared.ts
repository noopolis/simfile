import { ZodError } from "zod";

import {
  createBindingDiagnostics,
  loadSpawnfileReport,
  type BindingDiagnostic,
  type Simfile,
} from "../schema/index.js";

export const simfileCliUsage = (): string => [
  "Usage:",
  "  simfile validate <path> [--json] [--spawnfile-report <path>|<json>]",
  "  simfile run <path> [--mode live|lifecycle-replay-smoke] [--view] [--out <dir>] [--seed <seed>] [--run-id <id>]",
  "  simfile run <path> --local --ticks <n> [--out <dir>] [--seed <seed>] [--run-id <id>] [--acts <path>] [--clock <iso>] [--moltnet-artifact transcript|delivery] [--spawnfile-report <path>|<json>]",
  "  simfile observe <run-dir> [--json]",
  "  simfile view --state <path>",
  "  simfile view <run-record-dir>",
  "  simfile recover --journal <absolute-path> --run-id <expected> --authority-digest <sha256>",
  "  simfile view --help",
  "  simfile --help",
  "",
].join("\n");

export const formatCliError = (error: unknown): string => error instanceof ZodError
  ? error.issues.map((issue) =>
    `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n")
  : error instanceof Error ? error.message : String(error);

export const bindingDiagnostics = async (
  simfile: Simfile,
  warnings: string[],
  reportSource?: string,
): Promise<BindingDiagnostic[]> => [
  ...warnings.map((message): BindingDiagnostic => ({ level: "warn", message })),
  ...(reportSource === undefined ? []
    : createBindingDiagnostics(simfile, await loadSpawnfileReport(reportSource))),
];

export const hasErrorDiagnostic = (diagnostics: readonly BindingDiagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.level === "error");

export const printDiagnostics = (diagnostics: readonly BindingDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.level === "error" ? "error" : "warning";
    process.stderr.write(`${prefix}: ${diagnostic.message}\n`);
  }
};
