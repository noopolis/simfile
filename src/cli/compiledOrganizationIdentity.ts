import { z } from "zod";

import { digestComposedJson } from "../compose/json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const compileFingerprint = z.string().regex(/^sf1:[a-f0-9]{12}$/u);

const compileReportSchema = z.object({
  compile_fingerprint: compileFingerprint,
  container: z.object({
    moltnet: z.object({
      release: z.object({
        architecture: z.enum(["amd64", "arm64"]),
        asset: z.string().min(1),
        asset_sha256: digest,
        capabilities: z.tuple([z.literal("pi-bridge")]),
        release_version: z.string().min(1),
        source_revision: z.string().regex(/^[a-f0-9]{40}$/u),
        version: z.literal("spawnfile.moltnet-release-identity.v1"),
      }).strict(),
    }).passthrough(),
    runtime_instances: z.array(z.object({
      engine_by_node_id: z.record(z.string().min(1), z.string().min(1)),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

export type SpawnfileCompileReport = z.infer<typeof compileReportSchema>;

export const parseSpawnfileCompileReport = (raw: unknown): SpawnfileCompileReport =>
  compileReportSchema.parse(raw);

export const deriveCompiledOrganizationArtifactDigest = (
  compile_fingerprint: string,
): `sha256:${string}` => digestComposedJson(
  "simfile.spawnfile-compiled-organization-artifact.v1",
  { compile_fingerprint: compileFingerprint.parse(compile_fingerprint) },
);

export const compileReportMemberEngines = (
  report: SpawnfileCompileReport,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const runtime of report.container.runtime_instances) {
    for (const [member, engine] of Object.entries(runtime.engine_by_node_id)) {
      if (result[member] !== undefined && result[member] !== engine) {
        throw new TypeError("Spawnfile member engine assignment is contradictory");
      }
      result[member] = engine;
    }
  }
  if (Object.keys(result).length < 1) throw new TypeError("Spawnfile member engines are absent");
  return Object.freeze(result);
};

export const compileReportMoltnetReleaseExpectation = (
  report: SpawnfileCompileReport,
): Readonly<{
  architecture: "amd64" | "arm64";
  asset_sha256: string;
  release_version: string;
  source_revision: string;
}> => {
  const release = report.container.moltnet.release;
  return Object.freeze({
    architecture: release.architecture,
    asset_sha256: release.asset_sha256,
    release_version: release.release_version,
    source_revision: release.source_revision,
  });
};
