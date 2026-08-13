import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pattern = process.env.SIMFILE_CENSUS_HOOK_PATTERN ?? "fixture-ownership census permanently enforces";
const regenerationCommand = 'SIMFILE_UPDATE_FIXTURE_OWNERSHIP_CENSUS=1 node --import tsx --test --test-name-pattern "explicit maintainer command refreshes the derived ownership census" src/ownership/fixtureOwnershipRatchet.test.ts';

if (process.env.SIMFILE_SKIP_CENSUS_HOOK === "1") {
  console.error("WARNING: SIMFILE_SKIP_CENSUS_HOOK=1 bypassed the fixture-ownership census guard.");
  process.exit(0);
}

const env = { ...process.env };
// The child must never be able to repair the artifact this guard is checking.
delete env.SIMFILE_UPDATE_FIXTURE_OWNERSHIP_CENSUS;
// When the guard is itself invoked from inside a node:test run, an inherited
// NODE_TEST_CONTEXT makes the child refuse to run any file ("run() is being called
// recursively") and emit no TAP at all. Without this the guard would report a
// failure it never actually measured.
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", "--test-reporter=tap", "--test-name-pattern", pattern,
  "src/ownership/fixtureOwnershipRatchet.test.ts",
], { cwd: root, env, encoding: "utf8" });
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const hasExpectedTap = /^# pass 1$/m.test(stdout)
  && /^# fail 0$/m.test(stdout)
  && /^# tests 1$/m.test(stdout);
const matchedATest = !/^1\.\.0$/m.test(stdout);

if (result.status !== 0 || !hasExpectedTap || !matchedATest) {
  console.error("Fixture-ownership census guard failed or matched no test.");
  console.error(`Regenerate with: ${regenerationCommand}`);
  console.error("Then git add fixtures/sims/tiny-football/ownership-census.json and retry.");
  if (stderr.trim()) console.error(stderr.trim());
  // node --test reports the failing assertion on stdout, so a guard that printed only
  // stderr would refuse the commit without ever saying what was uncovered.
  if (stdout.trim()) console.error(stdout.trim().split("\n").slice(-60).join("\n"));
  process.exit(result.status && result.status > 0 ? result.status : 1);
}
