import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalComposedJson } from "../compose/json.js";

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const environment = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u);

export interface ComposedWorldBindingInput {
  readonly capability_manifest: unknown;
  readonly id: string;
  readonly principal_id: string;
  readonly token_env: string;
}

const sha256 = (value: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Predicts Spawnfile's public, secret-free world-binding artifact before auth mutation. */
export const createComposedWorldBindings = (input: Readonly<{
  json_url: string;
  mcp_url: string;
  members: readonly ComposedWorldBindingInput[];
  run_id: string;
  world_instance_id: string;
}>): Readonly<{ artifact: Readonly<Record<string, unknown>>; bytes: string;
  digest: `sha256:${string}` }> => {
  const bindings = input.members.map((member) => {
    const id = identifier.parse(member.id);
    if (member.principal_id !== `agent:${id}`) {
      throw new TypeError("composed world member principal must be its canonical agent identity");
    }
    return {
      member: { id, principal_id: member.principal_id },
      run_id: input.run_id,
      world_instance_id: input.world_instance_id,
      capability_manifest_digest: sha256(canonicalComposedJson(member.capability_manifest)),
      token_env: environment.parse(member.token_env),
      json: { auth: "bearer" as const, url: input.json_url },
      mcp: { auth: "bearer" as const, transport: "streamable_http" as const,
        url: input.mcp_url },
    };
  }).sort((left, right) => left.member.principal_id < right.member.principal_id ? -1
    : left.member.principal_id > right.member.principal_id ? 1
      : left.member.id < right.member.id ? -1 : left.member.id > right.member.id ? 1 : 0);
  if (bindings.length < 1
    || new Set(bindings.map(({ member }) => member.id)).size !== bindings.length
    || new Set(bindings.map(({ token_env }) => token_env)).size !== bindings.length
    || new Set(bindings.map(({ capability_manifest_digest }) =>
      capability_manifest_digest)).size !== bindings.length) {
    throw new TypeError("composed world bindings are not uniquely correlated");
  }
  const artifact = Object.freeze({ schema: "simfile.world-bindings.v1" as const,
    bindings: Object.freeze(bindings) });
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  return Object.freeze({ artifact, bytes, digest: sha256(bytes) });
};
