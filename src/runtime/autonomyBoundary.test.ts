import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export const productionTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
    if (
      !entry.isFile()
      || !entry.name.endsWith(".ts")
      || entry.name.endsWith(".test.ts")
      || entry.name.endsWith(".test-helper.ts")
    ) return [];
    return [entryPath];
  }));
  return nested.flat();
};

const legacyBasenames = [
  "worldTickLoop.ts",
  "exchangeWait.ts",
  "exchangeWait.test.ts",
  "moltnetRoomClient.ts",
  "worldDrivenOfficeSimDriver.ts",
  "composedOfficeSimDriver.ts",
  "composedJungianSimDriver.ts"
] as const;
const legacyPaths = new Set(["src/sims/index.ts"]);

type SourceMap = ReadonlyMap<string, string>;

const serializedAgentApi = /\b(?:awaitDecision|runAgentTurn|nextAgent|activeAgent|roundRobin|sendAndWait|AgentTurnGateway|ConversationPort|awaitParticipant|nextParticipant|runParticipantTurn|pollParticipant)\b/u;
const directProviderConversation = /(?:listMoltnetRoomMessages|pollRoomMessages|roomMessages?\s*poll|poll\s*.*roomMessages|\/v1\/rooms\/[^\s"'`]*\/messages)/iu;
const daimonModelControlImport = /\b(?:from|import|require)\s*\(?\s*["'][^"']*(?:@[^"']+\/)?(?:daimon|cognition|model|control)(?:[\/"'])/iu;
const wakeDeliveryRetryLoop = /(?:for\s*\(\s*;\s*;\s*\)|while\s*\((?:[^()]|\([^()]*\))*\))\s*\{(?=[\s\S]{0,4000}\bsend_nudge\b)(?=[\s\S]{0,4000}\b(?:attempt|deliver(?:ed|y|ies)?|retry|sleep|setTimeout)\b)[\s\S]{0,4000}\}/iu;
const wakeDeliveryRetryVocabulary = /\b(?:(?:wake|nudge)[A-Za-z0-9_$]*(?:retry|redeliver)[A-Za-z0-9_$]*|max[A-Za-z0-9_$]*(?:wake|nudge)[A-Za-z0-9_$]*deliver(?:y|ies)[A-Za-z0-9_$]*)\b/iu;
const blockingWakeDeliveryAwait = /\bawait\s+(?:(?:[\w$]+\.)*[\w$]*(?:dispatch|send|deliver|emit|request)[\w$]*(?:decision|wake|nudge|delivery)[\w$]*\s*\(|(?:Promise\.all|Promise\.race)\s*\([\s\S]{0,800}?\b(?:[\w$]+\.)*[\w$]*(?:dispatch|send|deliver|emit|request)[\w$]*(?:decision|wake|nudge|delivery)[\w$]*\s*\()/iu;
const inlineBlockingSendNudgeAwait = /\bawait\s+[\s\S]{0,500}?\b(?:operation\s*:\s*["']send_nudge["']|send_nudge\s*:)/iu;
const productionFixtureImport = /\b(?:from|import|require)\s*\(?\s*["'][^"']*fixtures\//iu;

const directProviderConversationExemptions = new Set([
  // Provider-owned transcript export is the read-only evidence adapter.
  "src/moltnet/transcript-export.ts",
  // The world participant is Simfile's declared semantic Moltnet binding.
  "src/moltnet/world-participant.ts"
]);

export const findAutonomyBoundaryViolations = (sources: SourceMap): string[] => {
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const label = (file.startsWith(packageRoot) ? path.relative(packageRoot, file) : file).replaceAll("\\", "/");
    const containsSendNudge = /\bsend_nudge\b/u.test(source);
    for (const [name, pattern, exempt] of [
      ["serialized-agent API", serializedAgentApi, false],
      ["direct provider conversation polling", directProviderConversation, directProviderConversationExemptions.has(label)],
      ["Daimon/model/control import", daimonModelControlImport, false],
      ["production fixture import", productionFixtureImport, false]
    ] as const) {
      if (!exempt && pattern.test(source)) violations.push(`${label}: ${name}`);
    }
    if (
      containsSendNudge
      && (wakeDeliveryRetryLoop.test(source)
        || wakeDeliveryRetryVocabulary.test(source))
    ) {
      violations.push(`${label}: wake-delivery retry ownership`);
    }
    if (
      containsSendNudge
      && (blockingWakeDeliveryAwait.test(source)
        || inlineBlockingSendNudgeAwait.test(source))
    ) {
      violations.push(`${label}: blocking wake-delivery await`);
    }
    if (legacyPaths.has(label) || legacyBasenames.some((basename) => path.basename(file) === basename)) {
      violations.push(`${label}: deleted legacy basename`);
    }
    for (const basename of legacyBasenames) {
      if (source.includes(basename)) violations.push(`${label}: deleted legacy symbol ${basename}`);
    }
  }
  return violations;
};

test("world and fixture production layers do not own agent cognition or legacy loops", async () => {
  const files = (await Promise.all(
    ["src", "fixtures"].map((root) =>
      productionTypeScriptFiles(path.join(packageRoot, root))),
  )).flat();
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)));
  assert.deepEqual(findAutonomyBoundaryViolations(sources), []);
  assert.equal(files.some((file) => legacyPaths.has(path.relative(packageRoot, file))), false);
});

test("hostile autonomy sources are rejected by every boundary class", () => {
  const cases = [
    ["src/runtime/hostile.ts", "await nextAgent(); roundRobin();", "serialized-agent API"],
    ["src/world/hostile.ts", "await fetch('/v1/rooms/r/messages');", "direct provider conversation polling"],
    ["src/cli/hostile.ts", "await fetch('/v1/rooms/r/messages');", "direct provider conversation polling"],
    ["src/observe/hostile.ts", "pollRoomMessages();", "direct provider conversation polling"],
    ["src/moltnet/hostile.ts", "await fetch('/v1/rooms/r/messages');", "direct provider conversation polling"],
    ["src/runtime/hostile.ts", "import { wake } from '@noopolis/daimon';", "Daimon/model/control import"],
    ["src/sims/worldTickLoop.ts", "export const retired = true;", "deleted legacy basename"],
    ["src/runtime/hostile.ts", "const legacy = 'exchangeWait.ts';", "deleted legacy symbol exchangeWait.ts"],
    [
      "fixtures/runtime/retryingWake.ts",
      `for (;;) {
        const result = await machine.request({
          operation: "send_nudge",
          send_nudge: { delivery_id: "wake_1" },
        });
        if (result.send_nudge) return;
        await sleep(1_000);
      }`,
      "wake-delivery retry ownership",
    ],
    [
      "fixtures/runtime/scheduledWakeRetry.ts",
      `const wakeRetryMs = 1_000;
      const request = { operation: "send_nudge" };`,
      "wake-delivery retry ownership",
    ],
    [
      "fixtures/runtime/blockingTick.ts",
      `while (running) {
        await dispatchWake({ operation: "send_nudge" });
        tick();
      }`,
      "blocking wake-delivery await",
    ],
    [
      "src/run/hostile.ts",
      'import { x } from "../../fixtures/sims/example/controller.js";',
      "production fixture import",
    ],
    ["src/run/hostile.ts", "awaitParticipant();", "serialized-agent API"],
    ["src/run/hostile.ts", "nextParticipant();", "serialized-agent API"],
    ["src/run/hostile.ts", "runParticipantTurn();", "serialized-agent API"],
    ["src/run/hostile.ts", "pollParticipant();", "serialized-agent API"]
  ] as const;
  for (const [file, source, expectedClass] of cases) {
    const violations = findAutonomyBoundaryViolations(
      new Map([[file, source]]),
    );
    assert.ok(
      violations.includes(`${file}: ${expectedClass}`),
      `${file}: expected ${expectedClass}; received ${violations.join(", ")}`,
    );
  }
});

test("fixture harnesses are not a public package surface", async () => {
  const [rootBarrel, packageJson] = await Promise.all([
    readFile(path.join(packageRoot, "src", "index.ts"), "utf8"),
    readFile(path.join(packageRoot, "package.json"), "utf8")
  ]);

  assert.doesNotMatch(rootBarrel, /from ["']\.\/sims/u);
  assert.doesNotMatch(packageJson, /"\.\/sims"/u);
  assert.doesNotMatch(packageJson, /"\.\/testing"/u);
});
