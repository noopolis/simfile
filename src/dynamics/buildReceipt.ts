import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  createDynamicsClosureIdentity,
  type DynamicsBuildInputDescriptor,
  deepFreeze,
  sha256
} from "./buildIdentity.js";
import { DYNAMICS_BUILD_CONTRACT } from "./buildInput.js";
import {
  buildReceiptLock,
  type DynamicsReceiptLockDeduplicatedLock,
  type DynamicsReceiptLockPortableRecord,
  type DynamicsReceiptLockToolIdentity,
  type DynamicsReceiptSelfLinkEntry
} from "./buildReceiptLock.js";
import { validateStaticSourcePath } from "./buildStaticPolicy.js";
import { resolveSimfileProjectRoot } from "./buildReceiptLockFiles.js";
import { type PreparedDynamicsBuild } from "./build.js";
import {
  buildReceiptConfigDigest,
  closurePreparationPolicy,
  normalizePreparedBuild,
  type NormalizedPreparedBuild
} from "./buildReceiptValidation.js";
import {
  assertCanonicalClaims,
  assertDedupedLocks,
  assertPortableClaims,
  assertSourceClaims,
  assertToolset
} from "./buildReceiptSourceEvidence.js";
import { assertCanonicalSelfLinkEntries } from "./buildReceiptSelfLinks.js";

const fail = (message: string): never => { throw new Error(message); };

export const DYNAMICS_BUILD_RECEIPT_VERSION = "simfile.dynamics-build-receipt.v1" as const;

export interface DynamicsBuildReceiptRuntimeIdentity {
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly v8: string;
}

export interface DynamicsBuildReceiptPayload {
  readonly schema: typeof DYNAMICS_BUILD_RECEIPT_VERSION;
  readonly module: string;
  readonly source_graph: readonly DynamicsBuildInputDescriptor[];
  readonly source_graph_sha256: string;
  readonly build_config_sha256: string;
  readonly closure_header: string;
  readonly closure_sha256: string;
  readonly used_node_externals: readonly string[];
  readonly runtime_identity: DynamicsBuildReceiptRuntimeIdentity;
  readonly artifact_sha256: string;
  readonly artifact_path: string;
  readonly build_tools: readonly DynamicsReceiptLockToolIdentity[];
  readonly deduped_locks: readonly DynamicsReceiptLockDeduplicatedLock[];
  readonly portable_claims: readonly DynamicsReceiptLockPortableRecord[];
  readonly self_link_entries: readonly DynamicsReceiptSelfLinkEntry[];
}

export interface DynamicsBuildReceipt {
  readonly payload: DynamicsBuildReceiptPayload;
  readonly receiptBytes: readonly number[];
  readonly receiptSha256: string;
}

const canonicalSourceGraphDigest = (sourceGraph: readonly DynamicsBuildInputDescriptor[]): string => {
  return sha256(canonicalJson(sourceGraph));
};

const assertRuntimeProject = (
  inputs: readonly DynamicsBuildInputDescriptor[],
  entry: string
): DynamicsBuildInputDescriptor & { readonly kind: "project" } => {
  const projects = inputs.filter((input): input is DynamicsBuildInputDescriptor & { readonly kind: "project" } =>
    input.kind === "project"
    && input.path === entry
    && input.modes.includes("runtime")
  );
  if (projects.length !== 1) {
    fail("prepared.inputs must include exactly one project descriptor matching prepared module with runtime mode");
  }
  const [project] = projects;
  if (project === undefined) fail("prepared.project missing");
  return project;
};

export const createDynamicsBuildReceipt = async (
  absoluteSimfilePath: string,
  prepared: PreparedDynamicsBuild
): Promise<DynamicsBuildReceipt> => {
  if (!path.isAbsolute(absoluteSimfilePath)) fail("prepared simfile path must be absolute");
  const normalized = normalizePreparedBuild(prepared);

  const projectRoot = await resolveSimfileProjectRoot(absoluteSimfilePath);
  for (const input of normalized.inputs) {
    if (input.kind !== "project") continue;
    const absolute = await validateStaticSourcePath(
      path.join(projectRoot, input.path.slice(2)),
      projectRoot
    );
    const observed = sha256(await readFile(absolute));
    if (observed !== input.sha256) fail(`prepared project descriptor mismatch: ${input.path}`);
  }

  const expectedClosure = createDynamicsClosureIdentity({
    buildContract: DYNAMICS_BUILD_CONTRACT,
    entry: normalized.closure.entry,
    esbuildVersion: normalized.closure.esbuildVersion,
    inputs: normalized.closure.inputs,
    preparationPolicy: closurePreparationPolicy,
    typecheckMode: normalized.closure.preparedTypecheckMode,
    typescriptVersion: normalized.closure.typescriptVersion,
    usedNodeBuiltins: normalized.closure.usedNodeBuiltins
  });

  if (canonicalJson(expectedClosure.descriptor) !== canonicalJson(prepared.closureDescriptor)) {
    fail("prepared.closureDescriptor mismatch");
  }
  if (expectedClosure.sha256 !== normalized.closureSha256) {
    fail("prepared closure SHA mismatch");
  }
  assertRuntimeProject(normalized.inputs, normalized.closure.entry);

  const closureHeaderBytes = new TextEncoder().encode(expectedClosure.header);
  if (normalized.artifactBytes.length < closureHeaderBytes.length) fail("artifact header truncated");
  for (let index = 0; index < closureHeaderBytes.length; index += 1) {
    if (normalized.artifactBytes[index] !== closureHeaderBytes[index]) fail("artifact header mismatch");
  }
  if (closureHeaderBytes[closureHeaderBytes.length - 1] !== 10) fail("artifact header is not LF-terminated");

  const lockInputs = normalized.inputs.filter((input): input is typeof normalized.inputs[number] & { kind: "package" | "type-only" } =>
    input.kind === "package" || input.kind === "type-only"
  );

  const lockAuthority = await buildReceiptLock(
    absoluteSimfilePath,
    lockInputs,
    normalized.closure.esbuildVersion,
    normalized.closure.typescriptVersion
  );

  const buildTools = assertToolset(
    lockAuthority.toolchainAuthority.tool_identities,
    normalized.closure.esbuildVersion,
    normalized.closure.typescriptVersion
  );

  const portableClaims = assertCanonicalClaims(lockAuthority.portableClaims);
  assertPortableClaims(portableClaims);
  const dedupedLocks = assertDedupedLocks(lockAuthority.dedupedLocks);
  const selfLinkEntries = assertCanonicalSelfLinkEntries(lockAuthority.selfLinkEntries);
  assertSourceClaims(normalized.inputs, portableClaims, lockInputs, buildTools);

  const sourceGraph = deepFreeze([...normalized.inputs]);
  const payload: DynamicsBuildReceiptPayload = deepFreeze({
    schema: DYNAMICS_BUILD_RECEIPT_VERSION,
    module: normalized.closure.entry,
    source_graph: sourceGraph,
    source_graph_sha256: canonicalSourceGraphDigest(sourceGraph),
    build_config_sha256: buildReceiptConfigDigest,
    closure_header: expectedClosure.header,
    closure_sha256: expectedClosure.sha256,
    used_node_externals: normalized.nodeBuiltins,
    runtime_identity: deepFreeze({
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      v8: process.versions.v8
    }),
    artifact_sha256: normalized.artifactSha256,
    artifact_path: `./dynamics/sha256-${normalized.artifactSha256}/provider.mjs`,
    build_tools: buildTools,
    deduped_locks: dedupedLocks,
    portable_claims: portableClaims,
    self_link_entries: selfLinkEntries
  });

  const payloadBytes = new TextEncoder().encode(`${canonicalJson(payload)}\n`);
  const receiptBytes = deepFreeze(Array.from(payloadBytes));
  const receiptSha256 = sha256(Uint8Array.from(receiptBytes));

  return deepFreeze({
    payload,
    receiptBytes,
    receiptSha256
  });
};
