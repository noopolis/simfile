import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DYNAMICS_BUILD_CONTRACT } from "../dynamics/buildInput.js";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { simfileSchema } from "./model.js";
import { parseSimfileSource } from "./parse.js";

describe("dynamics schema", () => {
  it("accepts portable project-relative TypeScript and ESM module paths", () => {
    for (const modulePath of [
      "./systems/tiny.ts",
      "./systems/tiny.mjs",
      "./.hidden/_provider-file.mjs",
      "./Systems/Physics.ts",
      "./-vendor/provider.mjs"
    ]) {
      const result = parseSimfileSource(`
simfile_version: "0.1"
name: dynamics-world
clock:
  seed: dynamics
  tick: 50ms
dynamics:
  module: ${modulePath}
  config:
    dimensions: 2
    gravity: [0, 9.81]
    collisions:
      enabled: true
`, { path: "Simfile" });

      assert.deepEqual(result.simfile.dynamics, {
        module: modulePath,
        config: {
          dimensions: 2,
          gravity: [0, 9.81],
          collisions: { enabled: true }
        }
      });
      assert.deepEqual(Object.keys(result.simfile.dynamics.config), ["collisions", "dimensions", "gravity"]);
    }
  });

  it("rejects unsafe, nonportable, and unsupported dynamics module paths", () => {
    for (const modulePath of [
      "/tmp/physics.mjs", "../physics.mjs", "physics.mjs", "file:///tmp/physics.mjs",
      "https://example.test/physics.mjs", "./systems/physics.mjs?cache=1", "./systems/physics.mjs#entry",
      "./systems/physics\0.mjs", "./systems\\physics.mjs", "./systems//physics.mjs", "././physics.mjs",
      "./systems/../physics.mjs", "./systems/not portable.mjs", "./systems/C:physics.mjs",
      "./systems/physics.js", "./systems/physics.cjs", "./systems/physics.mts", "./systems/physics.cts",
      "./systems/physics.tsx", "./systems/physics.d.ts", "./systems/physics.TS", "./systems/physics.MJS",
      "./systems/physics.ts.bak", "./systems/physics.mjs.txt"
    ]) {
      assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: dynamics-world
clock: { seed: dynamics, tick: 50ms }
dynamics:
  module: ${JSON.stringify(modulePath)}
`, { path: "Simfile" }), /portable project-relative path|\.ts or \.mjs module/u);
    }
  });

  it("publishes an exact deeply immutable dynamics build contract", () => {
    assert.deepEqual(DYNAMICS_BUILD_CONTRACT, {
      allowedExtensions: [".ts", ".mjs"],
      typescript: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext"
      },
      esbuild: {
        platform: "node",
        format: "esm",
        target: "node22",
        bundle: true,
        sourcemap: false,
        legalComments: "none",
        charset: "utf8"
      }
    });
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.allowedExtensions), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.typescript), true);
    assert.equal(Object.isFrozen(DYNAMICS_BUILD_CONTRACT.esbuild), true);
    assert.throws(() => {
      (DYNAMICS_BUILD_CONTRACT.allowedExtensions as unknown as string[]).push(".js");
    }, TypeError);
    assert.throws(() => {
      (DYNAMICS_BUILD_CONTRACT.esbuild as { target: string }).target = "node20";
    }, TypeError);
  });

  it("bounds authored clock seeds only when dynamics is declared", () => {
    const seed = "x".repeat(DYNAMICS_LIMITS.identifier_code_units + 1);
    const clock = `clock: { seed: ${seed}, tick: 1s }`;
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: bounded-seed
${clock}
dynamics: { module: ./systems/tiny.mjs }
`, { path: "Simfile" }), /clock\.seed.*256 code units/u);
    assert.equal(parseSimfileSource(`
simfile_version: "0.1"
name: legacy-seed
${clock}
`, { path: "Simfile" }).simfile.clock.seed, seed);
  });

  it("rejects non-JSON dynamics configuration values", () => {
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: dynamics-world
clock: { seed: dynamics, tick: 50ms }
dynamics:
  module: ./systems/tiny.mjs
  config: { invalid: .nan }
`, { path: "Simfile" }), /NaN|Invalid input|finite numbers/u);
  });

  it("rejects prototype-sensitive dynamics config keys in YAML and JSON", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const json = `{"simfile_version":"0.1","name":"unsafe-config","clock":{"seed":"config","tick":"1s"},"dynamics":{"module":"./systems/tiny.mjs","config":{${JSON.stringify(key)}:1}}}`;
      assert.throws(() => parseSimfileSource(json, { path: "Simfile.json" }), /safe dynamics JSON key/u);
      const yaml = `
simfile_version: "0.1"
name: unsafe-config
clock: { seed: config, tick: 1s }
dynamics:
  module: ./systems/tiny.mjs
  config:
    ${JSON.stringify(key)}: 1
`;
      assert.throws(() => parseSimfileSource(yaml, { path: "Simfile" }), /safe dynamics JSON key/u);
    }
  });

  it("enforces config depth and cumulative code-unit limits while parsing", () => {
    let deep: unknown = 0;
    for (let index = 0; index <= DYNAMICS_LIMITS.json_depth; index += 1) deep = { nested: deep };
    const base = {
      clock: { seed: "config", tick: "1s" },
      dynamics: { config: deep, module: "./systems/tiny.mjs" },
      name: "bounded-config",
      simfile_version: "0.1"
    };
    assert.throws(
      () => parseSimfileSource(JSON.stringify(base), { path: "Simfile.json" }),
      /depth limit/u
    );

    const entries = Array.from(
      { length: Math.floor(DYNAMICS_LIMITS.json_code_units / 1_000) + 1 },
      (_, index) => `    value_${index}: ${JSON.stringify("x".repeat(1_000))}`
    ).join("\n");
    assert.throws(() => parseSimfileSource(`
simfile_version: "0.1"
name: bounded-config
clock: { seed: config, tick: 1s }
dynamics:
  module: ./systems/tiny.mjs
  config:
${entries}
`, { path: "Simfile" }), /cumulative.*code-unit limit/u);
  });

  it("canonicalizes negative zero in YAML and JSON dynamics config", () => {
    for (const [source, path] of [[`
simfile_version: "0.1"
name: zero-config
clock: { seed: config, tick: 1s }
dynamics:
  module: ./systems/tiny.mjs
  config: { zero: -0 }
`, "Simfile"], [
      '{"simfile_version":"0.1","name":"zero-config","clock":{"seed":"config","tick":"1s"},"dynamics":{"module":"./systems/tiny.mjs","config":{"zero":-0}}}',
      "Simfile.json"
    ]] as const) {
      const parsed = parseSimfileSource(source, { path }).simfile.dynamics?.config.zero;
      assert.equal(parsed, 0);
      assert.equal(Object.is(parsed, -0), false);
    }
  });

  it("rejects nonplain, accessor-backed, and sparse programmatic config", () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    class Config { value = 1; }
    for (const config of [{ sparse }, accessor, new Config()]) {
      assert.throws(() => simfileSchema.parse({
        clock: { seed: "config", tick: "1s" },
        dynamics: { config, module: "./systems/tiny.mjs" },
        name: "programmatic-config",
        simfile_version: "0.1"
      }), /sparse arrays|enumerable data value|plain JSON objects/u);
    }
  });
});
