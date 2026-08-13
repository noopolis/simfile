import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requiredBuildOutputs = [
  "dist/index.js", "dist/index.d.ts", "dist/schema/index.js", "dist/schema/index.d.ts",
  "dist/moltnet/index.js", "dist/moltnet/index.d.ts", "dist/dynamics/index.js", "dist/dynamics/index.d.ts",
  "dist/observe/index.js", "dist/observe/index.d.ts", "dist/runtime/index.js", "dist/runtime/index.d.ts",
  "dist/spawnfile/index.js", "dist/spawnfile/index.d.ts", "dist/cli/index.js", "dist/cli/index.d.ts",
  "web/dist/index.html", "web/dist/assets/probe.js",
];

async function buildProbePackage(): Promise<{ root: string; events: string }> {
  const probeRoot = await mkdtemp(path.join(tmpdir(), "simfile-public-build-gate-"));
  const events = path.join(probeRoot, "events.log");
  await Promise.all([
    mkdir(path.join(probeRoot, "src"), { recursive: true }),
    mkdir(path.join(probeRoot, "web", "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(probeRoot, "tsconfig.json"), "{}\n"),
    writeFile(path.join(probeRoot, "tsconfig.build.json"), "{}\n"),
    writeFile(path.join(probeRoot, "tsconfig.web.json"), "{}\n"),
    writeFile(path.join(probeRoot, "src", "probe.ts"), "export {};\n"),
    writeFile(path.join(probeRoot, "web", "src", "probe.ts"), "export {};\n"),
    writeFile(path.join(probeRoot, "web", "vite.config.ts"), "export default {};\n"),
    writeFile(path.join(probeRoot, "package.json"), '{"scripts":{"build":"node build.mjs"}}\n'),
  ]);
  await writeFile(path.join(probeRoot, "build.mjs"), [
    'import { appendFile, mkdir, writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    'const root = process.cwd();',
    'const events = process.env.SIMFILE_PUBLIC_BUILD_EVENTS;',
    'if (events) await appendFile(events, `start ${process.pid}\\n`);',
    'await new Promise((resolve) => setTimeout(resolve, 700));',
    `for (const output of ${JSON.stringify(requiredBuildOutputs)}) {`,
    '  const destination = path.join(root, output);',
    '  await mkdir(path.dirname(destination), { recursive: true });',
    '  await writeFile(destination, "ok\\n");',
    '}',
    'if (events) await appendFile(events, `finish ${process.pid}\\n`);',
  ].join("\n"));
  return { root: probeRoot, events };
}

const buildEvents = async (events: string): Promise<string[]> =>
  (await readFile(events, "utf8")).trim().split("\n").map((line) => line.split(" ")[0]!);

async function startInterruptedBuild(probeRoot: string, stage: "before" | "after") {
  const runner = path.join(probeRoot, "interrupted-build.mts");
  const helper = new URL("../publicPackageBuild.test-helper.ts", import.meta.url).href;
  await writeFile(runner, [
    `import { ensurePublicPackageBuild } from ${JSON.stringify(helper)};`,
    'const [stage, packageRoot] = process.argv.slice(2);',
    'const pause = async () => { process.send?.(stage); await new Promise<void>(() => {}); };',
    'await ensurePublicPackageBuild(packageRoot, stage === "before"',
    '  ? { afterGatedChildSpawned: pause }',
    '  : { afterGateOpened: pause });',
  ].join("\n"));
  const child = spawn(process.execPath, ["--import", "tsx", runner, stage, probeRoot], {
    cwd: root,
    env: { ...process.env, SIMFILE_PUBLIC_BUILD_EVENTS: path.join(probeRoot, "events.log") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const [message] = await once(child, "message");
  assert.equal(message, stage);
  return child;
}

test("public package build gate contains a killed parent before and after its child starts", { skip: process.platform === "win32" }, async () => {
  const previousEvents = process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
  const before = await buildProbePackage();
  const after = await buildProbePackage();
  try {
    process.env.SIMFILE_PUBLIC_BUILD_EVENTS = before.events;
    const beforeRunner = await startInterruptedBuild(before.root, "before");
    process.kill(beforeRunner.pid!, "SIGKILL");
    await once(beforeRunner, "close");
    await ensurePublicPackageBuild(before.root);
    assert.deepEqual(await buildEvents(before.events), ["start", "finish"],
      "a parent killed before opening the gate must not launch its build");

    process.env.SIMFILE_PUBLIC_BUILD_EVENTS = after.events;
    const afterRunner = await startInterruptedBuild(after.root, "after");
    process.kill(afterRunner.pid!, "SIGKILL");
    await once(afterRunner, "close");
    await ensurePublicPackageBuild(after.root);
    assert.deepEqual(await buildEvents(after.events), ["start", "finish", "start", "finish"],
      "a parent killed after opening the gate must retain the child lock until that build exits");
  } finally {
    if (previousEvents === undefined) delete process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
    else process.env.SIMFILE_PUBLIC_BUILD_EVENTS = previousEvents;
    await Promise.all([rm(before.root, { force: true, recursive: true }), rm(after.root, { force: true, recursive: true })]);
  }
});

test("public package build marker authenticates the complete output tree and root compiler config", async () => {
  const previousEvents = process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
  const probe = await buildProbePackage();
  try {
    process.env.SIMFILE_PUBLIC_BUILD_EVENTS = probe.events;
    await ensurePublicPackageBuild(probe.root);
    await ensurePublicPackageBuild(probe.root);
    assert.deepEqual(await buildEvents(probe.events), ["start", "finish"], "an intact complete marker must reuse its build");
    await rm(path.join(probe.root, "web", "dist", "assets", "probe.js"));
    await ensurePublicPackageBuild(probe.root);
    assert.deepEqual(await buildEvents(probe.events), ["start", "finish", "start", "finish"], "a missing emitted web asset must force a rebuild");
    await writeFile(path.join(probe.root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2023"}}\n');
    await ensurePublicPackageBuild(probe.root);
    assert.deepEqual(await buildEvents(probe.events), ["start", "finish", "start", "finish", "start", "finish"], "a root compiler-config change must force a rebuild");
    await writeFile(path.join(probe.root, "dist", "index.js"), "corrupt\n");
    await ensurePublicPackageBuild(probe.root);
    assert.deepEqual(await buildEvents(probe.events), ["start", "finish", "start", "finish", "start", "finish", "start", "finish"], "a changed emitted output byte must force a rebuild");
  } finally {
    if (previousEvents === undefined) delete process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
    else process.env.SIMFILE_PUBLIC_BUILD_EVENTS = previousEvents;
    await rm(probe.root, { force: true, recursive: true });
  }
});

test("public package build marker hashes every Vite input outside generated web output", async () => {
  const previousEvents = process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
  const probe = await buildProbePackage();
  try {
    process.env.SIMFILE_PUBLIC_BUILD_EVENTS = probe.events;
    await ensurePublicPackageBuild(probe.root);
    await writeFile(path.join(probe.root, "web", "index.html"), "<main>changed index</main>\n");
    await ensurePublicPackageBuild(probe.root);
    await mkdir(path.join(probe.root, "web", "public"), { recursive: true });
    await writeFile(path.join(probe.root, "web", "public", "changed-asset.txt"), "changed public asset\n");
    await ensurePublicPackageBuild(probe.root);
    await writeFile(path.join(probe.root, "web", "new-web-input.ts"), "export const changed = true;\n");
    await ensurePublicPackageBuild(probe.root);
    assert.deepEqual(await buildEvents(probe.events), ["start", "finish", "start", "finish", "start", "finish", "start", "finish"],
      "index.html, public assets, and newly added web inputs must each invalidate the successful-build marker");
  } finally {
    if (previousEvents === undefined) delete process.env.SIMFILE_PUBLIC_BUILD_EVENTS;
    else process.env.SIMFILE_PUBLIC_BUILD_EVENTS = previousEvents;
    await rm(probe.root, { force: true, recursive: true });
  }
});
