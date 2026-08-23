import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalComposedJson } from "../compose/json.js";
import { createComposedWorldBindings } from "./composedWorldBindings.js";

const sha = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("world-binding prediction matches Spawnfile's canonical public artifact", () => {
  const manifest = { effects: ["observe"], entity: "counter" };
  const result = createComposedWorldBindings({
    json_url: "http://world:4070/v1/world",
    mcp_url: "http://world:4070/mcp",
    members: [{ capability_manifest: manifest, id: "smoke",
      principal_id: "agent:smoke", token_env: "SIMFILE_WORLD_TOKEN" }],
    run_id: "run-one",
    world_instance_id: "world-one",
  });
  assert.equal(result.artifact.schema, "simfile.world-bindings.v1");
  const binding = (result.artifact.bindings as Array<Record<string, unknown>>)[0]!;
  assert.equal(binding.capability_manifest_digest, sha(canonicalComposedJson(manifest)));
  assert.equal(result.digest, sha(result.bytes));
  assert.equal(result.bytes, `${JSON.stringify(result.artifact, null, 2)}\n`);
});

test("world-binding prediction requires canonical Spawnfile agent principals", () => {
  assert.throws(() => createComposedWorldBindings({
    json_url: "http://world:4070/v1/world",
    mcp_url: "http://world:4070/mcp",
    members: [{ capability_manifest: {}, id: "smoke",
      principal_id: "principal:smoke", token_env: "SIMFILE_WORLD_TOKEN" }],
    run_id: "run-one",
    world_instance_id: "world-one",
  }), /canonical agent identity/u);
});
