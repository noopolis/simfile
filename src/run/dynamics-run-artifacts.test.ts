import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseRunManifest, RUN_MANIFEST_VERSION } from "../observe/manifest.js";
import {
  createDynamicsRunArtifactWriter,
  dynamicsRunStagingPrefix,
  type DynamicsRunArtifactWriter,
  type DynamicsRunFileOperations
} from "./dynamics-run-artifacts.js";

const realOperations: DynamicsRunFileOperations = {
  mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir
};

const operationsWith = (
  overrides: Partial<DynamicsRunFileOperations>
): DynamicsRunFileOperations => Object.assign({}, realOperations, overrides);

const stagingEntries = async (outDir: string): Promise<string[]> =>
  (await readdir(path.dirname(outDir)))
    .filter((entry) => entry.startsWith(dynamicsRunStagingPrefix(outDir)));

const populate = async (
  writer: DynamicsRunArtifactWriter,
  writeActionStream = true
): Promise<string> => {
  const artifactPath = `dynamics/sha256-${"a".repeat(64)}/provider.mjs`;
  await mkdir(path.join(writer.stagingRealPath, path.dirname(artifactPath)), {
    recursive: true
  });
  await writeFile(
    path.join(writer.stagingRealPath, "dynamics/build-receipt.json"),
    "{}\n"
  );
  await writeFile(path.join(writer.stagingRealPath, artifactPath), "export {};\n");
  await writer.writeJson("provenance.json", {});
  if (writeActionStream) await writer.writeJson("replay/action-stream.json", {});
  await writer.writeJson("replay/final-session.json", {});
  await writer.writeJson("replay/initial-session.json", {});
  await writer.writeJson("summary.json", {});
  await writer.writeBytes(
    "viewer-extensions.json",
    Buffer.from("{\"extensions\":[],\"version\":\"simfile.project-viewer-extensions.v1\"}\n")
  );
  return artifactPath;
};

describe("createDynamicsRunArtifactWriter", () => {
  it("defers JSONL syncs until flush and syncs all handles at seal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-flush-"));
    try {
      const outDir = path.join(root, "run");
      let syncCount = 0;
      const syncTargets: string[] = [];
      const operations = operationsWith({
        open: (async (...args: Parameters<typeof open>) => {
          const target = String(args[0]);
          const handle = await open(...args);
          return new Proxy(handle, {
            get(value, property, receiver) {
              if (property === "sync") {
                return async () => {
                  syncCount += 1;
                  syncTargets.push(target);
                  return value.sync();
                };
              }
              return Reflect.get(value, property, receiver);
            }
          }) as FileHandle;
        }) as typeof open
      });
      const writer = await createDynamicsRunArtifactWriter({
        fileOperations: operations,
        outDir
      });
      const evidenceArtifactPath = await populate(writer);
      syncCount = 0;
      syncTargets.length = 0;

      await writer.appendJsonl("raw/steps.jsonl", { line: 1 });
      await writer.appendJsonl("raw/steps.jsonl", { line: 2 });
      await writer.appendJsonl("raw/frames.jsonl", { line: 1 });
      assert.equal(syncCount, 0);
      await writer.flush();
      assert.equal(syncCount, 2);
      await writer.flush();
      assert.equal(syncCount, 2);

      const beforeSeal = syncCount;
      await writer.appendJsonl("raw/world/causal.jsonl", { line: 1 });
      await writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "flush",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      });
      assert.ok(syncCount > beforeSeal);
      const sealedSyncTargets = new Set(
        syncTargets.filter((target) => target.endsWith(".jsonl")).slice(-8).map((target) =>
          target.slice(target.indexOf("raw/"))
        )
      );
      assert.deepEqual(sealedSyncTargets, new Set([
        "raw/action-attempts.jsonl",
        "raw/action-results.jsonl",
        "raw/commitment-outcomes.jsonl",
        "raw/frames.jsonl",
        "raw/steps.jsonl",
        "raw/world/action-refusals.jsonl",
        "raw/world/perception.jsonl",
        "raw/world/causal.jsonl"
      ]));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("closes every JSONL handle when sealing flush fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-flush-failure-"));
    try {
      const outDir = path.join(root, "run");
      const syncFailure = new Error("injected fsync failure");
      const closed: string[] = [];
      const operations = operationsWith({
        open: (async (...args: Parameters<typeof open>) => {
          const target = String(args[0]);
          const handle = await open(...args);
          return new Proxy(handle, {
            get(value, property, receiver) {
              if (property === "sync") {
                return async () => {
                  if (target.endsWith("raw/steps.jsonl")) throw syncFailure;
                  return value.sync();
                };
              }
              if (property === "close") {
                return async () => {
                  if (target.endsWith(".jsonl")) closed.push(target);
                  return value.close();
                };
              }
              return Reflect.get(value, property, receiver);
            }
          }) as FileHandle;
        }) as typeof open
      });
      const writer = await createDynamicsRunArtifactWriter({
        fileOperations: operations,
        outDir
      });
      const evidenceArtifactPath = await populate(writer);
      await writer.appendJsonl("raw/steps.jsonl", { line: 1 });

      await assert.rejects(
        writer.seal({
          evidenceArtifactPath,
          manifestFactory: (artifacts) => parseRunManifest({
            version: RUN_MANIFEST_VERSION,
            run_id: "flush-failure",
            created_at: new Date(0).toISOString(),
            contract_versions: {},
            artifacts
          })
        }),
        (failure: unknown) =>
          failure instanceof AggregateError
          && failure.errors.includes(syncFailure)
      );
      assert.equal(closed.length, 8);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses an existing output directory without changing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-exists-"));
    try {
      const outDir = path.join(root, "run");
      await mkdir(outDir);
      await writeFile(path.join(outDir, "keep"), "kept");
      await assert.rejects(
        createDynamicsRunArtifactWriter({ outDir }),
        new Error(
          `refusing to reuse unsealed run directory: ${outDir}; `
          + "it may be a crash-orphaned reservation; after confirming no run process "
          + `is active, remove this directory and matching ${dynamicsRunStagingPrefix(outDir)}* `
          + "directories before retrying"
        )
      );
      assert.equal(await readFile(path.join(outDir, "keep"), "utf8"), "kept");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("identifies a crash-orphanable empty reservation and documents recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-orphan-"));
    const outDir = path.join(root, "run");
    const writer = await createDynamicsRunArtifactWriter({ outDir });
    try {
      await assert.rejects(
        createDynamicsRunArtifactWriter({ outDir }),
        (failure: unknown) =>
          failure instanceof Error
          && failure.message.includes(
            `remove this directory and matching ${dynamicsRunStagingPrefix(outDir)}* directories before retrying`
          )
      );
      assert.deepEqual(await readdir(outDir), []);
      assert.equal((await stagingEntries(outDir)).length, 1);
    } finally {
      await writer.abort();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("abort removes staging and its owned reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-abort-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      await writer.abort();
      await assert.rejects(access(outDir));
      assert.deepEqual(await stagingEntries(outDir), []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("N10a removes the reservation after an injected mkdtemp failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-n10a-"));
    try {
      const outDir = path.join(root, "run");
      const injected = new Error("N10a");
      const operations = operationsWith({
        mkdtemp: (async () => { throw injected; }) as typeof mkdtemp
      });
      await assert.rejects(
        createDynamicsRunArtifactWriter({ fileOperations: operations, outDir }),
        (error) => error === injected
      );
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("N10b cleans real staging after a raw/world mkdir failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-n10b-"));
    try {
      const outDir = path.join(root, "run");
      const injected = new Error("N10b");
      const operations = operationsWith({
        mkdir: (async (...args: Parameters<typeof mkdir>) => {
          if (String(args[0]).endsWith(`${path.sep}raw${path.sep}world`)) {
            throw injected;
          }
          return mkdir(...args);
        }) as typeof mkdir
      });
      await assert.rejects(
        createDynamicsRunArtifactWriter({ fileOperations: operations, outDir }),
        (error) => error === injected
      );
      await assert.rejects(access(outDir));
      assert.deepEqual(await stagingEntries(outDir), []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("N10c closes the first handle when the second open fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-n10c-"));
    try {
      const outDir = path.join(root, "run");
      const injected = new Error("N10c");
      const closed: string[] = [];
      const operations = operationsWith({
        open: (async (...args: Parameters<typeof open>) => {
          const target = String(args[0]);
          if (target.endsWith("raw/action-results.jsonl")) throw injected;
          const handle = await open(...args);
          return new Proxy(handle, {
            get(value, property) {
              if (property === "close") {
                return async () => {
                  closed.push(target);
                  return value.close();
                };
              }
              const member = Reflect.get(value, property);
              return typeof member === "function" ? member.bind(value) : member;
            }
          }) as FileHandle;
        }) as typeof open
      });
      await assert.rejects(
        createDynamicsRunArtifactWriter({ fileOperations: operations, outDir }),
        (error) => error === injected
      );
      assert.equal(closed.length, 1);
      assert.match(closed[0] ?? "", /raw\/action-attempts\.jsonl$/u);
      await assert.rejects(access(outDir));
      assert.deepEqual(await stagingEntries(outDir), []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("N10d combines construction and cleanup errors primary-first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-n10d-"));
    try {
      const outDir = path.join(root, "run");
      const openFailure = new Error("N10d-open");
      const rmFailure = new Error("N10d-rm");
      const operations = operationsWith({
        open: (async (...args: Parameters<typeof open>) => {
          if (String(args[0]).endsWith("raw/action-results.jsonl")) {
            throw openFailure;
          }
          return open(...args);
        }) as typeof open,
        rm: (async (...args: Parameters<typeof rm>) => {
          if (String(args[0]).includes(dynamicsRunStagingPrefix(outDir))) {
            throw rmFailure;
          }
          return rm(...args);
        }) as typeof rm
      });
      await assert.rejects(
        createDynamicsRunArtifactWriter({ fileOperations: operations, outDir }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message,
            "dynamics run artifact construction and cleanup both failed");
          assert.equal(error.errors[0], openFailure);
          assert.equal(error.errors[1], rmFailure);
          return true;
        }
      );
      await assert.rejects(access(outDir));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("seals fixed staged bytes with recomputed manifest hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-seal-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      const evidenceArtifactPath = await populate(writer);
      await writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "seal",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      });
      const manifest = parseRunManifest(JSON.parse(
        await readFile(path.join(outDir, "manifest.json"), "utf8")
      ));
      assert.equal(manifest.artifacts.length, 16);
      assert.equal(
        manifest.artifacts.some(({ path }) =>
          path === "raw/commitment-outcomes.jsonl"),
        true,
      );
      assert.equal(
        manifest.artifacts.some(({ path }) =>
          path === "raw/world/action-refusals.jsonl"),
        true,
      );
      assert.equal(
        manifest.artifacts.some(({ path }) =>
          path === "raw/world/perception.jsonl"),
        true,
      );
      for (const entry of manifest.artifacts) {
        const digest = createHash("sha256")
          .update(await readFile(path.join(outDir, entry.path))).digest("hex");
        assert.equal(entry.sha256, digest);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("streams replay actions from durable attempts without retaining retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-replay-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      const attempt = (sequence: number) => ({
        act_id: `act-${sequence}`,
        action: "advance",
        actor: "actor:one",
        at_tick: sequence - 1,
        input: { sequence },
        origin: "controller",
        principal_id: "controller:one",
        target: "object:one"
      });
      const source = { id: "source", live_acceptance: false, provenance: "scripted" };
      for (const sequence of [1, 1, 2]) {
        await writer.appendJsonl("raw/action-attempts.jsonl", {
          attempt: attempt(sequence),
          receipt: {
            act_id: `act-${sequence}`,
            apply_tick: sequence - 1,
            queued: true,
            sequence
          },
          source,
          version: "simfile.dynamics-run-action-ingress.v1"
        });
      }
      await writer.writeActionReplay({
        finalCheckpoint: "replay/final-session.json",
        firstActionSequence: 1,
        initialCheckpoint: "replay/initial-session.json",
        runId: "replay",
        version: "simfile.dynamics-run-replay-input.v1"
      });
      const evidenceArtifactPath = await populate(writer, false);
      await writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "replay",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      });
      const replay = JSON.parse(await readFile(
        path.join(outDir, "replay/action-stream.json"),
        "utf8"
      )) as { actions: Array<{ act_id: string }> };
      assert.deepEqual(replay.actions.map((entry) => entry.act_id), ["act-1", "act-2"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the reservation fail-closed when it becomes non-empty at seal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-artifacts-race-"));
    try {
      const outDir = path.join(root, "run");
      const writer = await createDynamicsRunArtifactWriter({ outDir });
      const evidenceArtifactPath = await populate(writer);
      await writeFile(path.join(outDir, "tamper"), "x");
      await assert.rejects(writer.seal({
        evidenceArtifactPath,
        manifestFactory: (artifacts) => parseRunManifest({
          version: RUN_MANIFEST_VERSION,
          run_id: "race",
          created_at: new Date(0).toISOString(),
          contract_versions: {},
          artifacts
        })
      }));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("T8 production writers do not use bare JSON.stringify", async () => {
    const source = await readFile(
      new URL("./dynamics-run-artifacts.ts", import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(source, /\bJSON\.stringify\s*\(/u);
  });
});
