import { spawn } from "node:child_process";

export const defaultTestArguments = ["src/**/*.test.ts", "web/src/**/*.test.ts"];
export const nodeTestArguments = (testArguments) => [
  "--import", "tsx", "--test", "--test-reporter=tap", ...testArguments,
];

const summaryPattern = /^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu;

export const parseTapSummary = (output) => {
  const counts = {};
  for (const match of String(output).matchAll(summaryPattern)) {
    counts[match[1]] = Number(match[2]);
  }
  const required = ["tests", "pass", "fail", "cancelled", "skipped"];
  if (required.some((name) => !Number.isInteger(counts[name]))) {
    throw new Error("test run summary could not be parsed");
  }
  return counts;
};

export const adjudicateSummary = (summary, nodeExitCode) => {
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

export const runTests = (testArguments = defaultTestArguments) => new Promise((resolve) => {
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
  child.on("error", (error) => {
    console.error(`test runner could not start: ${error.message}`);
    resolve(1);
  });
  child.on("close", (nodeExitCode) => {
    let summary;
    try {
      summary = parseTapSummary(output);
    } catch (error) {
      if (nodeExitCode === 0) console.error(`test run is not green: ${error.message}`);
      resolve(nodeExitCode || 1);
      return;
    }
    const verdict = adjudicateSummary(summary, nodeExitCode);
    if (verdict.message) console.error(verdict.message);
    resolve(verdict.exitCode);
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runTests(process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultTestArguments);
}
