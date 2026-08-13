import assert from "node:assert/strict";
import test from "node:test";

import { projectCredentialBindingNames } from "./credentialBindingProjection.js";

test("projects one credential alias across provisioning, bindings, and members", () => {
  const projected = projectCredentialBindingNames({
    credentials: [
      { env: "BLUE_WORLD", kind: "generated-token", name: "blue_world" },
      { env: "ORG_TOKEN", kind: "generated-token", name: "org_token" },
    ],
    secret_bindings: [
      { credential_name: "blue_world", name: "blue_bearer", scope: "world" },
    ],
    world_members: [{ id: "blue", token_credential_name: "blue_world" }],
  });
  assert.deepEqual(projected.credentials, [
    { env: "BLUE_WORLD", kind: "generated-token", name: "blue_bearer" },
    { env: "ORG_TOKEN", kind: "generated-token", name: "org_token" },
  ]);
  assert.deepEqual(projected.secret_bindings, [
    { credential_name: "blue_bearer", name: "blue_bearer", scope: "world" },
  ]);
  assert.deepEqual(projected.world_members, [
    { id: "blue", token_credential_name: "blue_bearer" },
  ]);
});

test("rejects duplicate source use and alias collisions before provisioning", () => {
  const base = {
    credentials: [{ name: "blue_world" }, { name: "blue_bearer" }],
    world_members: [{ token_credential_name: "blue_world" }],
  };
  assert.throws(() => projectCredentialBindingNames({
    ...base,
    secret_bindings: [
      { credential_name: "blue_world", name: "blue_one", scope: "world" },
      { credential_name: "blue_world", name: "blue_two", scope: "world" },
    ],
  }), /identity is invalid/u);
  assert.throws(() => projectCredentialBindingNames({
    ...base,
    secret_bindings: [
      { credential_name: "blue_world", name: "blue_bearer", scope: "world" },
    ],
  }), /alias collides/u);
});
