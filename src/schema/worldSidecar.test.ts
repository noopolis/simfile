import assert from "node:assert/strict";
import test from "node:test";

import { parseSimfileSource } from "./parse.js";

const source = (declaration: string): string => `
simfile_version: "0.1"
name: project
clock:
  seed: fixed
  tick: 1s
world_sidecar:
${declaration}
`;

test("world sidecar declares portable composer and installed binding modules", () => {
  const parsed = parseSimfileSource(source(`
  binding: ./dist/runtime/project-binding.mjs
  composer: ./runtime/project-composer.ts
`), { path: "/project/Simfile" });
  assert.deepEqual(parsed.simfile.world_sidecar, {
    binding: "./dist/runtime/project-binding.mjs",
    composer: "./runtime/project-composer.ts",
  });
});

test("world sidecar rejects source escape and non-executable binding declarations", () => {
  for (const declaration of [
    "  binding: ../binding.mjs\n  composer: ./runtime/composer.ts",
    "  binding: ./runtime/binding.ts\n  composer: ./runtime/composer.ts",
    "  binding: ./dist/binding.mjs\n  composer: /runtime/composer.ts",
  ]) {
    assert.throws(() => parseSimfileSource(source(declaration), {
      path: "/project/Simfile",
    }), /world_sidecar/u);
  }
});
