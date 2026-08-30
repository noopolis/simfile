import assert from "node:assert/strict";
import test from "node:test";

import {
  SCRIPTED_NO_MODEL_AUTH_PROFILE,
  resolveSpawnfileOrganizationAuthentication,
} from "./organizationAuthentication.js";

test("all-scripted organizations carry only an inert correlation label", () => {
  const authentication = resolveSpawnfileOrganizationAuthentication({
    configured_auth_profile: "must-not-propagate",
    member_engines: { "agent:one": "scripted", "agent:two": "scripted" },
  });
  assert.deepEqual(authentication, {
    correlation_auth_profile: SCRIPTED_NO_MODEL_AUTH_PROFILE,
    kind: "scripted",
  });
  assert.equal("model_engine_auth" in authentication, false);
  assert.equal("spawnfile_up_auth_profile" in authentication, false);
});

test("Codex organizations retain explicit Codex import and Spawnfile profile", () => {
  for (const member_engines of [
    { "agent:one": "codex" },
    { "agent:one": "scripted", "agent:two": "codex" },
  ] as readonly Readonly<Record<string, string>>[]) {
    assert.deepEqual(resolveSpawnfileOrganizationAuthentication({
      configured_auth_profile: "developer-profile",
      member_engines,
    }), {
      correlation_auth_profile: "developer-profile",
      kind: "model",
      model_engine_auth: { kind: "codex", profile: "developer-profile" },
      spawnfile_up_auth_profile: "developer-profile",
    });
    assert.throws(() => resolveSpawnfileOrganizationAuthentication({ member_engines }),
      /require SPAWNFILE_AUTH_PROFILE/u);
  }
});

test("non-Codex model engines use the profile without fabricating Codex import", () => {
  for (const engine of ["agy", "claude", "grok"]) {
    assert.deepEqual(resolveSpawnfileOrganizationAuthentication({
      configured_auth_profile: "developer-profile",
      member_engines: { "agent:one": engine },
    }), {
      correlation_auth_profile: "developer-profile",
      kind: "model",
      spawnfile_up_auth_profile: "developer-profile",
    });
  }
});

test("an empty engine disclosure never downgrades authentication", () => {
  assert.throws(() => resolveSpawnfileOrganizationAuthentication({
    member_engines: {},
  }), /member engines are absent/u);
});
