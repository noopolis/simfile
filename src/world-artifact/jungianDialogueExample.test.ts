import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const exampleRoot = path.join(packageRoot, "examples", "jungian-dialogue");
const simfilePath = path.join(exampleRoot, "Simfile");
const spawnfilePath = path.join(exampleRoot, "org", "Spawnfile");
const digest = `sha256:${"a".repeat(64)}`;

test("jungian dialogue prepares two authenticated world members and exact replay truth", async () => {
  await ensurePublicPackageBuild(packageRoot);
  const binding = await import(`${pathToFileURL(
    path.join(exampleRoot, "binding.mjs"),
  ).href}?contract=${Date.now()}`) as {
    composedProjectBinding: {
      prepareComposedProject(input: unknown): Promise<any>;
      version: string;
    };
  };
  const kernelModule = await import(pathToFileURL(
    path.join(exampleRoot, "binding-world.mjs"),
  ).href) as { loadKernel(runId: string, seed: string): Promise<any> };
  const runId = "jungian-dialogue-contract";
  const seed = "jungian-dialogue-contract-seed";
  const preparation = await binding.composedProjectBinding.prepareComposedProject({
    base_image_config_digest: digest,
    evidence_root: "/var/lib/simfile/evidence",
    internal_port: 4070,
    organization_container_name: "jungian-dialogue-contract",
    platform: { architecture: process.arch === "arm64" ? "arm64" : "amd64", os: "linux" },
    run_id: runId,
    secret_root: "/run/spawnfile-secrets",
    seed,
    simfile_path: simfilePath,
    spawnfile_path: spawnfilePath,
  });

  assert.equal(binding.composedProjectBinding.version, "simfile.composed-project-binding.v1");
  assert.equal(preparation.terminal_tick, 12);
  assert.deepEqual(preparation.world_members.map((member: any) => member.id), [
    "analyst", "daimon",
  ]);
  assert.deepEqual(preparation.world_members.map((member: any) => member.principal_id), [
    "agent:analyst", "agent:daimon",
  ]);
  assert.deepEqual(preparation.credentials.map((credential: any) => credential.env), [
    "SIMFILE_WORLD_TOKEN_ANALYST", "SIMFILE_WORLD_TOKEN_DAIMON",
  ]);
  assert.equal(preparation.evidence_artifacts.length, 10);
  assert.equal(preparation.readiness_expectation.capability_manifest_digests.length, 2);
  assert.equal(preparation.readiness_expectation.capabilities.length, 1);
  assert.equal(preparation.readiness_expectation.capabilities[0].manifest_digest,
    preparation.readiness_expectation.capability_manifest_digests[0]);
  assert.ok(preparation.world_members.every(
    (member: any) => member.capability_manifest?.holder?.principal === member.principal_id,
  ));

  const kernel = await kernelModule.loadKernel(runId, seed);
  const replayState = await preparation.replay_adapter.restore(kernel.checkpoint);
  const replay = await preparation.replay_adapter.finish(replayState);
  assert.equal(replay.terminal_tick, 12);
  const terminal = JSON.parse(new TextDecoder().decode(replay.terminal_state));
  assert.equal(terminal.dynamics.next_tick, 12);
  assert.equal(terminal.dynamics.provider_state.elapsed_seconds, 12);
  const probe = JSON.parse(new TextDecoder().decode(replay.probe));
  assert.deepEqual(probe, {
    dialogue_evidence: "spawnfile_moltnet_export",
    live_agent_action: "not_evaluated",
    passed: true,
    run_id: runId,
    terminal_tick: 12,
    version: "simfile.composed-lifecycle-replay-smoke.v1",
  });
  await assert.rejects(Promise.resolve().then(() => preparation.replay_adapter.inject()),
    /accepts no recorded actions/u);
});

test("jungian screenplay is a bounded five-message mention chain with no model auth", async () => {
  const engine = await import(pathToFileURL(
    path.join(exampleRoot, "harness", "jungian-engine.mjs"),
  ).href) as {
    dreamOpeningText(dream: { dread: number; symbols: string[] }): string;
    scriptedReply(agent: string, prompt: string): string;
  };
  const messages = [engine.dreamOpeningText({
    dread: 0.72,
    symbols: ["black door", "tarnished mirror", "lost child"],
  })];
  messages.push(engine.scriptedReply("daimon", messages[0]!));
  messages.push(engine.scriptedReply("analyst", messages[1]!));
  messages.push(engine.scriptedReply("daimon", messages[2]!));
  messages.push(engine.scriptedReply("analyst", messages[3]!));
  assert.equal(messages.length, 5);
  assert.ok(messages.every((message) => message.length > 40));
  assert.ok(messages.slice(0, 4).every((message) => /@(analyst|daimon)\b/u.test(message)));
  assert.doesNotMatch(messages[4]!, /@[\w-]+/u);
  assert.match(messages.join("\n"), /black door[\s\S]*tarnished mirror[\s\S]*lost child/u);

  const spawnfiles = await Promise.all([
    spawnfilePath,
    path.join(exampleRoot, "org", "agents", "analyst", "Spawnfile"),
    path.join(exampleRoot, "org", "agents", "daimon", "Spawnfile"),
  ].map((file) => readFile(file, "utf8")));
  assert.match(spawnfiles[0]!, /members:\s*[\s\S]*id: analyst[\s\S]*id: daimon/u);
  assert.match(spawnfiles[0]!, /id: consulting-room[\s\S]*members: \[analyst, daimon\]/u);
  assert.ok(spawnfiles.slice(1).every((source) => /engine: scripted/u.test(source)));
  assert.doesNotMatch(spawnfiles.join("\n"), /(?:api[_-]?key|model:|grok|agy|openai)/iu);
});

test("jungian example is package-relative and follows implementation-folder guide links", async () => {
  for (const relative of [
    "binding.mjs", "binding-world.mjs", "harness/jungian-engine.mjs",
    "world/composer.mjs", "world/evidence.mjs", "world/provider.mjs", "world/surface.mjs",
  ]) {
    const source = await readFile(path.join(exampleRoot, relative), "utf8");
    assert.doesNotMatch(source,
      /(?:\/Users\/[^/]+\/|\/home\/[^/]+\/|[A-Za-z]:\\Users\\[^\\]+\\|\.\.\/spawnfile)/iu,
      relative);
  }
  for (const link of [
    "CLAUDE.md", "harness/CLAUDE.md", "org/CLAUDE.md",
    "org/agents/analyst/CLAUDE.md", "org/agents/daimon/CLAUDE.md", "world/CLAUDE.md",
  ]) {
    assert.equal((await lstat(path.join(exampleRoot, link))).isSymbolicLink(), true, link);
  }
});
