import { z } from "zod";

export const SCRIPTED_NO_MODEL_AUTH_PROFILE = "scripted-no-model-auth" as const;

const authProfile = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

export type SpawnfileOrganizationAuthentication =
  | Readonly<{
    correlation_auth_profile: typeof SCRIPTED_NO_MODEL_AUTH_PROFILE;
    kind: "scripted";
  }>
  | Readonly<{
    correlation_auth_profile: string;
    kind: "model";
    model_engine_auth?: Readonly<{ kind: "codex"; profile: string }>;
    spawnfile_up_auth_profile: string;
  }>;

/** Derives auth transport only from Spawnfile's compiled member-engine disclosure. */
export const resolveSpawnfileOrganizationAuthentication = (input: Readonly<{
  configured_auth_profile?: string;
  member_engines: Readonly<Record<string, string>>;
}>): SpawnfileOrganizationAuthentication => {
  const engines = Object.values(input.member_engines);
  if (engines.length < 1) {
    throw new TypeError("Spawnfile member engines are absent");
  }
  if (engines.every((engine) => engine === "scripted")) {
    return Object.freeze({
      correlation_auth_profile: SCRIPTED_NO_MODEL_AUTH_PROFILE,
      kind: "scripted" as const,
    });
  }
  if (input.configured_auth_profile === undefined) {
    throw new TypeError(
      "non-scripted composed organizations require SPAWNFILE_AUTH_PROFILE",
    );
  }
  let profile: string;
  try { profile = authProfile.parse(input.configured_auth_profile); }
  catch {
    throw new TypeError(
      "non-scripted composed organizations require SPAWNFILE_AUTH_PROFILE to be a safe identifier",
    );
  }
  return Object.freeze({
    correlation_auth_profile: profile,
    kind: "model" as const,
    ...(engines.includes("codex") ? {
      model_engine_auth: Object.freeze({ kind: "codex" as const, profile }),
    } : {}),
    spawnfile_up_auth_profile: profile,
  });
};
