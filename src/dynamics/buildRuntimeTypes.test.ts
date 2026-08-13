import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareDynamicsBuildWithSourceSnapshot } from "./build.js";
import {
  createBuildTestProject,
  prepareBuild,
  removeBuildTestPaths,
  writeBuildFile
} from "./buildTestSupport.test-helper.js";
import { sha256 } from "./buildIdentity.js";
import { runtimePackageNameForTypes } from "./buildPackagePolicy.js";
import {
  createDynamicsBuildSourceSnapshot,
  type DynamicsBuildSourceSnapshot
} from "./buildSourceSnapshot.js";

const mutateAfterFirstTextRead = (
  target: string,
  replacement: string
): Readonly<{
  didMutate: () => boolean;
  snapshot: DynamicsBuildSourceSnapshot;
}> => {
  const retained = createDynamicsBuildSourceSnapshot();
  let mutated = false;
  return {
    didMutate: () => mutated,
    snapshot: {
      ...retained,
      readText: async (fileName) => {
        const text = await retained.readText(fileName);
        if (!mutated && path.resolve(fileName) === path.resolve(target)) {
          mutated = true;
          await writeFile(target, replacement);
        }
        return text;
      }
    }
  };
};

describe("dynamics runtime and declaration package resolution", () => {
  it("maps DefinitelyTyped ownership to exact runtime package names", () => {
    assert.equal(runtimePackageNameForTypes("matter-js"), "matter-js");
    assert.equal(runtimePackageNameForTypes("@types/matter-js"), "matter-js");
    assert.equal(runtimePackageNameForTypes("@types/noopolis__engine"), "@noopolis/engine");
  });

  it("seals executable bytes and separate declaration evidence", async () => {
    const project = await createBuildTestProject();
    try {
      const runtimePackage = path.join(project.directory, "node_modules", "typed-runtime");
      const declarationPackage = path.join(
        project.directory,
        "node_modules",
        "@types",
        "typed-runtime"
      );
      const runtimeSource = "exports.value = 1;\n";
      const declarationSource = "export const value: number;\n";
      await writeBuildFile(
        { directory: runtimePackage },
        "package.json",
        JSON.stringify({
          name: "typed-runtime",
          version: "1.0.0",
          type: "commonjs",
          main: "./index.js"
        })
      );
      await writeBuildFile(
        { directory: runtimePackage },
        "index.js",
        runtimeSource
      );
      await writeBuildFile(
        { directory: declarationPackage },
        "package.json",
        JSON.stringify({
          name: "@types/typed-runtime",
          version: "1.0.0",
          types: "./index.d.ts"
        })
      );
      await writeBuildFile(
        { directory: declarationPackage },
        "index.d.ts",
        declarationSource
      );
      await writeBuildFile(
        project,
        "systems/provider.ts",
        "import { value } from 'typed-runtime'; export const output: number = value;\n"
      );

      const prepared = await prepareBuild(project, "./systems/provider.ts");
      const runtimeInput = prepared.inputs.find((input) =>
        input.kind === "package"
        && input.package_name === "typed-runtime"
        && input.package_path === "./index.js"
        && input.modes.includes("runtime")
      );
      const declarationInput = prepared.inputs.find((input) =>
        input.kind === "package"
        && input.package_name === "@types/typed-runtime"
        && input.package_path === "./index.d.ts"
        && input.modes.includes("type-only")
      );
      assert.ok(runtimeInput?.kind === "package");
      assert.ok(declarationInput?.kind === "package");
      assert.equal(runtimeInput.sha256, sha256(runtimeSource));
      assert.equal(declarationInput.sha256, sha256(declarationSource));

      for (const [target, original, replacement] of [
        [path.join(runtimePackage, "index.js"), runtimeSource, "exports.value = 2;\n"],
        [
          path.join(declarationPackage, "index.d.ts"),
          declarationSource,
          "export const value: string;\n"
        ]
      ] as const) {
        await writeFile(target, original);
        const canonicalTarget = await realpath(target);
        const mutation = mutateAfterFirstTextRead(canonicalTarget, replacement);
        await assert.rejects(
          prepareDynamicsBuildWithSourceSnapshot(
            project.simfilePath,
            "./systems/provider.ts",
            mutation.snapshot
          ),
          /source changed during preparation/u,
          `must reject mutation of ${canonicalTarget}`
        );
        assert.equal(mutation.didMutate(), true);
        await writeFile(target, original);
      }
    } finally {
      await removeBuildTestPaths(project.directory);
    }
  });
});
