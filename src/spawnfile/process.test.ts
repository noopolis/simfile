import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runSpawnfileConfigProducer, runSpawnfileProcess } from "./process.js";

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const waitForPids = async (root: string): Promise<number[]> => {
  const files = ["root.pid", "grandchild.pid", "great-grandchild.pid"];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const values = await Promise.all(files.map((file) =>
      readFile(path.join(root, file), "utf8").catch(() => "")));
    if (values.every((value) => /^\d+$/u.test(value))) return values.map(Number);
    await pause(10);
  }
  throw new Error("hostile process tree did not start");
};

const waitForTreeExit = async (pids: readonly number[]): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pids.every((pid) => !pidExists(pid))) return;
    await pause(10);
  }
  assert.deepEqual(pids.filter(pidExists), [], "process tree still has live members");
};

const killIndividuals = (pids: readonly number[]): void => {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
};

const writeHostileTree = async (root: string): Promise<string> => {
  const script = path.join(root, "hostile-tree.mjs");
  await writeFile(script, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const role=process.argv[2];
fs.writeFileSync(path.join(process.env.PID_ROOT,role+".pid"),String(process.pid));
process.on("SIGTERM",()=>{});
if(role==="root") spawn(process.execPath,[${JSON.stringify(script)},"grandchild"],{env:process.env,stdio:"ignore"});
if(role==="grandchild") spawn(process.execPath,[${JSON.stringify(script)},"great-grandchild"],{env:process.env,stdio:"ignore"});
if(role==="root") process.stdout.write("token=must-not-escape");
setInterval(()=>{},1000);
`, { mode: 0o700 });
  await chmod(script, 0o700);
  return script;
};

const assertAbortKillsTree = async (
  invoke: (script: string, signal: AbortSignal, root: string) => Promise<unknown>,
): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-process-tree-"));
  let pids: number[] = [];
  try {
    const script = await writeHostileTree(root);
    const controller = new AbortController();
    const pending = invoke(script, controller.signal, root);
    pids = await waitForPids(root);
    controller.abort();
    await assert.rejects(pending, (error: Error) =>
      /aborted/u.test(error.message) && !error.message.includes("must-not-escape"));
    await waitForTreeExit(pids);
  } finally {
    killIndividuals(pids);
    await rm(root, { force: true, recursive: true });
  }
};

test("abort terminates the Spawnfile process group through hostile descendants", async () => {
  await assertAbortKillsTree((script, signal, root) => runSpawnfileProcess({
    env: { ...process.env, PID_ROOT: root },
    spawnfileBin: script,
    terminationGraceMs: 20,
  }, { args: ["root"], signal }));
});

test("abort terminates the config producer process group through hostile descendants", async () => {
  await assertAbortKillsTree((script, signal, root) => runSpawnfileConfigProducer({
    args: ["root"],
    command: script,
    env: { ...process.env, PID_ROOT: root },
    signal,
    terminationGraceMs: 20,
  }));
});

test("normal exit and abort/exit races never affect an unrelated process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-process-race-"));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: process.platform !== "win32", stdio: "ignore",
  });
  try {
    const script = path.join(root, "exit.mjs");
    await writeFile(script, "process.stdout.write('ok');\n", { mode: 0o700 });
    assert.deepEqual(await runSpawnfileProcess({ spawnfileBin: script }, { args: [] }), {
      stderr: "", stdout: "ok",
    });
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const controller = new AbortController();
      const result = runSpawnfileProcess({ spawnfileBin: script }, {
        args: [], signal: controller.signal,
      }).then(() => "completed", () => "aborted");
      setImmediate(() => controller.abort());
      assert.match(await result, /^(?:aborted|completed)$/u);
    }
    assert.equal(pidExists(sentinel.pid!), true);
  } finally {
    if (sentinel.pid !== undefined) {
      try {
        process.kill(process.platform === "win32" ? sentinel.pid : -sentinel.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    await rm(root, { force: true, recursive: true });
  }
});
