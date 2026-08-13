import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveDynamicsModule } from "./modulePath.js";

interface TestProject {
  directory: string;
  simfilePath: string;
}

const createProject = async (): Promise<TestProject> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "simfile-module-path-"));
  const simfilePath = path.join(directory, "Simfile");
  await writeFile(simfilePath, "clock: {}\n", "utf8");
  return { directory, simfilePath };
};

const removeProject = async (project: TestProject): Promise<void> => {
  await rm(project.directory, { force: true, recursive: true });
};

const writeEntry = async (project: TestProject, reference: string, source = "entry bytes"): Promise<string> => {
  const entryPath = path.join(project.directory, ...reference.slice(2).split("/"));
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, source, "utf8");
  return entryPath;
};

describe("resolveDynamicsModule", () => {
  it("accepts the approved .ts and .mjs authored forms", async () => {
    const project = await createProject();
    try {
      for (const [reference, source] of [
        ["./systems/provider.ts", "typescript entry"],
        ["./systems/provider.mjs", "module entry"]
      ]) {
        const entryPath = await writeEntry(project, reference, source);
        const resolved = await resolveDynamicsModule(project.simfilePath, reference);
        assert.deepEqual(resolved, {
          absolutePath: await realpath(entryPath),
          module: reference,
          moduleSha256: createHash("sha256").update(source).digest("hex"),
          projectRoot: await realpath(project.directory)
        });
      }
    } finally {
      await removeProject(project);
    }
  });

  it("preserves portable segment compatibility", async () => {
    const project = await createProject();
    try {
      for (const reference of [
        "./.hidden/_provider-file.mjs",
        "./Systems/Physics.ts",
        "./-vendor/provider.mjs"
      ]) {
        await writeEntry(project, reference);
        assert.equal((await resolveDynamicsModule(project.simfilePath, reference)).module, reference);
      }
    } finally {
      await removeProject(project);
    }
  });

  it("rejects hostile module references", async () => {
    const project = await createProject();
    try {
      for (const reference of [
        "systems/provider.mjs", "/systems/provider.mjs", "./systems/provider.d.ts",
        "./systems/provider.tsx", "./systems/provider.js", "./systems/provider.mts",
        "./systems/provider.cts", "./systems/provider.TS", "./systems/provider.MJS",
        "./systems/provider.ts.bak", "https://example.test/provider.mjs",
        "./systems/provider.mjs?x=1", "./systems/provider.mjs#part", "./systems/\0provider.mjs",
        "./systems\\provider.mjs", "./systems/../provider.mjs", "./systems/./provider.mjs",
        "./systems//provider.mjs", "./../provider.mjs", "././provider.mjs"
      ]) {
        await assert.rejects(resolveDynamicsModule(project.simfilePath, reference));
      }
    } finally {
      await removeProject(project);
    }
  });

  it("rejects non-string references without invoking their endsWith hook", async () => {
    const project = await createProject();
    let endsWithTouched = false;
    const hostileReference = {
      get endsWith(): never {
        endsWithTouched = true;
        throw new Error("hostile endsWith getter invoked");
      }
    };
    try {
      await assert.rejects(
        resolveDynamicsModule(project.simfilePath, hostileReference as unknown as string),
        /portable/u
      );
      assert.equal(endsWithTouched, false);
    } finally {
      await removeProject(project);
    }
  });

  it("fails closed for a symlinked Simfile and every checked entry component", async () => {
    const project = await createProject();
    try {
      const linkedSimfile = path.join(project.directory, "LinkedSimfile");
      await symlink(project.simfilePath, linkedSimfile);
      await assert.rejects(resolveDynamicsModule(linkedSimfile, "./provider.mjs"), /non-symlink/u);

      const target = await writeEntry(project, "./target.mjs");
      await mkdir(path.join(project.directory, "systems"));
      await symlink(target, path.join(project.directory, "systems", "linked.mjs"));
      await assert.rejects(resolveDynamicsModule(project.simfilePath, "./systems/linked.mjs"), /symlinks/u);

      const realDirectory = path.join(project.directory, "real-systems");
      await mkdir(realDirectory);
      await writeFile(path.join(realDirectory, "provider.mjs"), "entry", "utf8");
      await symlink(realDirectory, path.join(project.directory, "linked-systems"));
      await assert.rejects(resolveDynamicsModule(project.simfilePath, "./linked-systems/provider.mjs"), /symlinks/u);
    } finally {
      await removeProject(project);
    }
  });

  it("rejects missing paths and a directory leaf", async () => {
    const project = await createProject();
    try {
      await assert.rejects(resolveDynamicsModule(project.simfilePath, "./missing.mjs"));
      await mkdir(path.join(project.directory, "directory.mjs"));
      await assert.rejects(resolveDynamicsModule(project.simfilePath, "./directory.mjs"), /regular file/u);
      await assert.rejects(resolveDynamicsModule(path.join(project.directory, "missing-simfile"), "./provider.mjs"));
    } finally {
      await removeProject(project);
    }
  });
});
