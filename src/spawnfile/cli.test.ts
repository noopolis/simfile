import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runSpawnfileArtifactsExport,
  runSpawnfileComposedPreparation,
  runSpawnfileDown,
  runSpawnfileUp,
} from "./cli.js";
import {
  composedPreparationReceiptFixture,
  composedPreparationRequestFixture,
} from "./preparationReceipt.test-helper.js";

const request = composedPreparationRequestFixture();

const script = async (root: string, body: string): Promise<string> => {
  const file = path.join(root, "fake-spawnfile.mjs");
  await writeFile(file, body, { mode: 0o700 });
  return file;
};

test("composed preparation wrapper sends exact argv/stdin and parses stdout apart from stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-cli-"));
  try {
    const capture = path.join(root, "capture.json");
    const receipt = composedPreparationReceiptFixture();
    const fake = await script(root, `import { writeFile } from "node:fs/promises";
let stdin = ""; process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
await writeFile(process.env.CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin }));
process.stderr.write("private progress channel\\n");
process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)});
`);
    const targetConfig = "B9_PRIVATE_TARGET_CONFIG";
    const result = await runSpawnfileComposedPreparation({
      spawnfileBin: fake,
      env: { ...process.env, CAPTURE_FILE: capture },
    }, { request, targetConfigStdin: targetConfig });
    assert.deepEqual(result, receipt);
    const recorded = JSON.parse(await readFile(capture, "utf8")) as {
      argv: string[]; stdin: string;
    };
    assert.deepEqual(recorded.argv.slice(0, 4), [
      "target", "--config", "-", "prepare_composed_run",
    ]);
    assert.equal(recorded.argv.length, 5);
    assert.equal(path.isAbsolute(recorded.argv[4]!), true);
    assert.equal(recorded.stdin, targetConfig);
    await assert.rejects(readFile(recorded.argv[4]!), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composed preparation wrapper bounds timeout and never reflects stderr or stdin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-cli-failure-"));
  try {
    const secret = "B9_PRIVATE_TARGET_CONFIG";
    const failed = await script(root, `let input = ""; for await (const chunk of process.stdin) input += chunk;
process.stderr.write(input + " token=password\\n"); process.exitCode = 1;`);
    await assert.rejects(
      runSpawnfileComposedPreparation({ spawnfileBin: failed }, {
        request, targetConfigStdin: secret,
      }),
      (error: Error) => !error.message.includes(secret) && !error.message.includes("password"),
    );
    const slow = await script(root, "setTimeout(() => {}, 10000);");
    await assert.rejects(
      runSpawnfileComposedPreparation({ spawnfileBin: slow, timeoutMs: 20 }, {
        request, targetConfigStdin: secret,
      }),
      /timed out/u,
    );
    const malformed = await script(root, "process.stdin.resume(); process.stdout.write('token=private');");
    await assert.rejects(
      runSpawnfileComposedPreparation({ spawnfileBin: malformed }, {
        request, targetConfigStdin: secret,
      }),
      (error: Error) => !error.message.includes("token=private") && !error.message.includes(secret),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("up binds retries to the exact lifecycle invocation and aborts without an orphan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-up-"));
  try {
    const capture = path.join(root, "capture.json");
    const receipt = {
      deployment: { container_ids: ["unit-one"], name: "organization-unit" },
      readiness: { moltnet_base_url: "http://127.0.0.1:1", state: "running" },
      run_id: "run-one",
      version: "spawnfile.up-receipt.v1",
    };
    const fake = await script(root, `import { writeFile } from "node:fs/promises";
await writeFile(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)});`);
    const invocation = "lci_startorganization000000000000";
    const upInput = {
      compiledOutputDirectory: "/compiled",
      containerName: "organization-unit",
      deploymentName: "organization-unit",
      descriptorDigest: `sha256:${"a".repeat(64)}`,
      dockerContext: "gpu-4090",
      envFile: "/private/runtime.env",
      imageTag: "organization-unit:run-one",
      lifecycleInvocationId: invocation,
      networkAttachmentHandle: "opaque_aaaaaaaaaaaaaaaa",
      organizationHandoffRunId: "run-one",
      orgPath: "/project/Spawnfile",
      selectedTargetReceiptDigest: `sha256:${"b".repeat(64)}`,
      selectedTargetReceiptFile: "/private/selected-target.json",
      worldBindingsFile: "/private/world-bindings.json",
    } as const;
    await runSpawnfileUp({
      spawnfileBin: fake,
      env: { ...process.env, CAPTURE_FILE: capture },
    }, upInput);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      "up", "/project/Spawnfile", "--detach", "--name", "organization-unit",
      "--deployment", "organization-unit", "--out", "/compiled",
      "--tag", "organization-unit:run-one", "--context", "gpu-4090",
      "--env-file", "/private/runtime.env",
      "--world-bindings", "/private/world-bindings.json",
      "--organization-handoff-run-id", "run-one",
      "--descriptor-digest", `sha256:${"a".repeat(64)}`,
      "--selected-target-receipt", "/private/selected-target.json",
      "--selected-target-receipt-digest", `sha256:${"b".repeat(64)}`,
      "--network-attachment-handle", "opaque_aaaaaaaaaaaaaaaa", "--json",
      "--lifecycle-invocation", invocation,
    ]);

    const pidFile = path.join(root, "pid");
    const blocked = await script(root, `import { writeFile } from "node:fs/promises";
await writeFile(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = runSpawnfileUp({
      spawnfileBin: blocked,
      env: { ...process.env, PID_FILE: pidFile },
      terminationGraceMs: 50,
    }, { ...upInput, signal: controller.signal });
    while (true) {
      try { await readFile(pidFile, "utf8"); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    controller.abort();
    await assert.rejects(pending, /aborted/u);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifacts export wrapper binds exact retry to one public lifecycle invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-export-"));
  try {
    const capture = path.join(root, "capture.json");
    const receipt = {
      deployment: "organization-unit",
      failed_files: [],
      index: {
        deployment: "organization-unit",
        exported_at: "2026-01-01T00:00:00.000Z",
        files: [{
          bytes: 1,
          path: "raw/moltnet/causal.jsonl",
          sha256: "a".repeat(64),
          source: { kind: "volume", ref: "volume:/causal.jsonl" },
        }],
        run_id: "run-one",
        version: "spawnfile.export-index.v1",
      },
      index_path: "/evidence/spawnfile/export-index.json",
      missing_optional_files: [],
    };
    const fake = await script(root, `import { writeFile } from "node:fs/promises";
await writeFile(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)});`);
    const invocation = "lci_exportevidence0000000000000000";
    assert.deepEqual(await runSpawnfileArtifactsExport({
      spawnfileBin: fake,
      env: { ...process.env, CAPTURE_FILE: capture },
    }, {
      compiledOutputDirectory: "/compiled",
      deploymentName: "organization-unit",
      destinationDirectory: "/evidence",
      lifecycleInvocationId: invocation,
      orgPath: "/project/Spawnfile",
    }), receipt);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      "artifacts", "export", "/project/Spawnfile",
      "--deployment", "organization-unit",
      "--compiled", "/compiled",
      "--out", "/evidence",
      "--json", "--lifecycle-invocation", invocation,
    ]);
    await assert.rejects(runSpawnfileArtifactsExport({ spawnfileBin: fake }, {
      compiledOutputDirectory: "/compiled",
      deploymentName: "organization-unit",
      destinationDirectory: "/evidence",
      lifecycleInvocationId: "lci_short",
      orgPath: "/project/Spawnfile",
    }), /invocation id is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("down wrapper binds exact retry without force and preserves volumes by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-spawnfile-down-"));
  try {
    const capture = path.join(root, "capture.json");
    const receipt = {
      deployment: "organization-unit",
      errors: [],
      retained_volumes: ["evidence-volume"],
      units_stopped: ["organization-container"],
      version: "spawnfile.down-receipt.v1",
    };
    const fake = await script(root, `import { writeFile } from "node:fs/promises";
await writeFile(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)});`);
    const invocation = "lci_downorganization000000000000000";
    assert.deepEqual(await runSpawnfileDown({
      spawnfileBin: fake,
      env: { ...process.env, CAPTURE_FILE: capture },
    }, {
      compiledOutputDirectory: "/compiled",
      deploymentName: "organization-unit",
      lifecycleInvocationId: invocation,
      orgPath: "/project/Spawnfile",
    }), receipt);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      "down", "/project/Spawnfile",
      "--deployment", "organization-unit",
      "--compiled", "/compiled",
      "--json", "--lifecycle-invocation", invocation,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
