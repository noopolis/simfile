import { spawn } from "node:child_process";

import { isMainModule } from "./entrypoint.ts";

export const defaultTestArguments = [
  "src/**/*.test.ts",
  "web/src/**/*.test.ts",
  "scripts/**/*.test.ts",
];
export const nodeTestArguments = (testArguments: readonly string[]): string[] => [
  "--import", "tsx", "--test", "--test-reporter=tap", ...testArguments,
];

const summaryPattern = /^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu;

export interface TapSummary {
  cancelled: number;
  fail: number;
  pass: number;
  skipped: number;
  tests: number;
}

export interface TestVerdict {
  exitCode: number;
  message: string | null;
}

export const parseTapSummary = (output: string): TapSummary => {
  const counts: Partial<Record<keyof TapSummary, number>> = {};
  for (const match of String(output).matchAll(summaryPattern)) {
    counts[match[1] as keyof TapSummary] = Number(match[2]);
  }
  const required: Array<keyof TapSummary> = ["tests", "pass", "fail", "cancelled", "skipped"];
  if (required.some((name) => !Number.isInteger(counts[name]))) {
    throw new Error("test run summary could not be parsed");
  }
  return counts as TapSummary;
};

export const adjudicateSummary = (summary: TapSummary, nodeExitCode: number): TestVerdict => {
  if (summary.cancelled > 0) {
    return {
      message: `test run is not green: ${summary.cancelled} test(s) cancelled — a cancelled test did not run`,
      exitCode: nodeExitCode || 1,
    };
  }
  if (summary.pass === 0) {
    return {
      message: "test run proved nothing: 0 tests passed (matched 0 files?)",
      exitCode: nodeExitCode || 1,
    };
  }
  if (nodeExitCode !== 0) return { message: null, exitCode: nodeExitCode || 1 };
  return { message: null, exitCode: 0 };
};

export const runTests = (testArguments: readonly string[] = defaultTestArguments): Promise<number> => new Promise((resolve) => {
  const child = spawn(process.execPath, nodeTestArguments(testArguments), {
    stdio: ["inherit", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  child.on("error", (error: Error) => {
    console.error(`test runner could not start: ${error.message}`);
    resolve(1);
  });
  child.on("close", (nodeExitCode) => {
    let summary;
    try {
      summary = parseTapSummary(output);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (nodeExitCode === 0) console.error(`test run is not green: ${message}`);
      resolve(nodeExitCode || 1);
      return;
    }
    const verdict = adjudicateSummary(summary, nodeExitCode ?? 1);
    if (verdict.message) console.error(verdict.message);
    resolve(verdict.exitCode);
  });
});

if (isMainModule(import.meta.url)) {
  process.exitCode = await runTests(process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultTestArguments);
}
