import { parseWorldSurfaceDefinition } from "../world-surface/index.js";
import { createDynamicsSession } from "../dynamics/session.js";
import type { DynamicsSession } from "../dynamics/session.js";
import type { WorldAffordanceContext, WorldSenseProjectionInput } from "../world-surface/types.js";
import { validWorldSurface } from "../world-surface/definition.test-helper.js";
import { compileCapabilityManifests } from "./capabilityManifest.js";
import { encodeWorldActEnvelope } from "./actEnvelope.js";
import { createDecisionRegistryForTesting } from "./decisionRegistry.js";
import { issueBoundWorldGrants } from "./grantAttestation.js";
import { createWorldReadLedger } from "./ledger.js";
import { createWorldRuntime } from "./runtime.js";
import { readWorldRuntimeActionJournalInspection } from "./actionJournalInspection.js";
import type { WorldActionJournalSnapshot } from "./actionJournalSnapshot.js";
import type { WorldActionJournalStatus } from "./actionJournal.js";
import { readWorldRuntimeRequestLedgerInspection } from "./requestLedgerInspection.js";
import type { WorldRequestLedgerSnapshot } from "./requestLedgerSnapshot.js";
import { readWorldRuntimeActionResultLedgerInspection } from "./actionResultLedgerInspection.js";
import type { WorldActionResultLedger } from "./actionResultLedger.js";

type RuntimeFixture = Omit<ReturnType<typeof buildRuntimeFixture>, "runtime"> & { readonly runtime: NonNullable<ReturnType<typeof buildRuntimeFixture>["runtime"]> };
type RuntimeIdentity = {
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly buildReceiptSha256?: string;
  readonly moduleSha256?: string;
  readonly redPrincipal?: string;
  readonly redAffordances?: readonly ("world://pitch/affordance/kick" | "world://pitch/affordance/wait")[];
  readonly redSenses?: readonly ("world://pitch/sense/vision" | "world://pitch/sense/red-detail")[];
  readonly maxLedgerPrincipals?: number;
  readonly fixedTargets?: readonly ("entity:ball" | "entity:blue")[];
  /** Keeps lifecycle fixtures on a deliberately short, issued decision window. */
  readonly decisionValidThroughTick?: number;
};

export type RuntimeFixtureHooks = {
  readonly observe?: (input: unknown, state: Record<string, unknown>, dynamics: DynamicsSession) => unknown;
  readonly project?: (input: WorldSenseProjectionInput, dynamics: DynamicsSession) => unknown;
  readonly projectDetail?: (input: WorldSenseProjectionInput, dynamics: DynamicsSession) => unknown;
  readonly available?: (input: WorldAffordanceContext, dynamics: DynamicsSession) => unknown;
  readonly lower?: (input: unknown, dynamics: DynamicsSession) => unknown;
  /** null deliberately omits the optional checked surface callback. */
  readonly projectResult?: ((input: unknown, dynamics: DynamicsSession) => unknown) | null;
  readonly randomBytes?: () => Uint8Array;
  /** Makes the real provider's next restore fail; the checked session still owns rollback. */
  readonly failRestore?: () => boolean;
  /** Runs inside the real provider's snapshot callback. */
  readonly snapshot?: () => void;
  readonly step?: (input: unknown, state: Record<string, unknown>, dynamics: DynamicsSession) => unknown;
};

export function runtimeFixture(): RuntimeFixture;
export function runtimeFixture(createRuntime: false, identity?: RuntimeIdentity): Omit<RuntimeFixture, "runtime"> & { readonly runtime: undefined };
export function runtimeFixture(createRuntime = true, identity: RuntimeIdentity = { runId: "run-1", worldInstanceId: "instance-1" }) { return buildRuntimeFixture(createRuntime, identity); }
export const runtimeFixtureWithHooks = (hooks: RuntimeFixtureHooks, createRuntime = true, identity: RuntimeIdentity = { runId: "run-1", worldInstanceId: "instance-1" }) =>
  buildRuntimeFixture(createRuntime, identity, hooks);

export const runtimeActionJournalSnapshot = (runtime: unknown): WorldActionJournalSnapshot | undefined =>
  readWorldRuntimeActionJournalInspection(runtime)?.snapshot();

export const runtimeActionJournalStatus = (runtime: unknown): WorldActionJournalStatus | undefined =>
  readWorldRuntimeActionJournalInspection(runtime)?.status();

export const runtimeRequestLedgerSnapshot = (runtime: unknown): WorldRequestLedgerSnapshot | undefined =>
  readWorldRuntimeRequestLedgerInspection(runtime)?.snapshot();

export const runtimeActionResultLedger = (runtime: unknown): WorldActionResultLedger | undefined =>
  readWorldRuntimeActionResultLedgerInspection(runtime);

export const runtimeActEnvelope = (requestId: string, request: Readonly<{ affordance: string; target: string; input: unknown }>): Uint8Array =>
  encodeWorldActEnvelope({ request_id: requestId, ...request });

const buildRuntimeFixture = (createRuntime: boolean, identity: RuntimeIdentity = { runId: "run-1", worldInstanceId: "instance-1" }, hooks: RuntimeFixtureHooks = {}) => {
  const surface = validWorldSurface() as {
    entities: Record<string, unknown>; senses: Record<string, unknown>; affordances: Record<string, unknown>;
  };
  surface.entities.blue = { address: "entity:blue", dynamics_address: "object:blue" };
  let dynamics: DynamicsSession;
  const projectedChannels = (input: WorldSenseProjectionInput) => input.observation.channels.map((channel) => ({
    components: channel.components,
    ...(channel.frame === undefined ? {} : { frame: channel.frame }),
    sense_address: "sense:vision",
    subject_address: "entity:red",
    ...(channel.unit === undefined ? {} : { unit: channel.unit }),
  }));
  surface.senses["sense:vision"] = {
    dynamics_senses: ["sense:state"], output: "simfile.numeric-observation.v1",
    project: (input: WorldSenseProjectionInput) => hooks.project?.(input, dynamics) ?? { channels: projectedChannels(input) },
  };
  surface.senses["sense:red-detail"] = { dynamics_senses: ["sense:detail"], output: "simfile.numeric-observation.v1", project: (input: WorldSenseProjectionInput) => hooks.projectDetail?.(input, dynamics) ?? ({ channels: projectedChannels(input).map((channel) => ({ ...channel, sense_address: "sense:red-detail" })) }) };
  surface.senses["sense:blue-view"] = { dynamics_senses: ["sense:blue-state"], output: "simfile.numeric-observation.v1", project: () => ({ channels: [] }) };
  if (identity.fixedTargets !== undefined) surface.affordances["affordance:kick"] = { ...surface.affordances["affordance:kick"] as object, target_selector: { kind: "fixed", targets: [...identity.fixedTargets] } };
  if (hooks.available !== undefined) surface.affordances["affordance:kick"] = { ...surface.affordances["affordance:kick"] as object, available: (input: WorldAffordanceContext) => hooks.available!(input, dynamics) };
  if (hooks.lower !== undefined) surface.affordances["affordance:kick"] = { ...surface.affordances["affordance:kick"] as object, lower: (input: unknown) => hooks.lower!(input, dynamics) };
  if (hooks.projectResult === null) {
    delete (surface.affordances["affordance:kick"] as Record<string, unknown>).project_result;
  } else if (hooks.projectResult !== undefined) {
    surface.affordances["affordance:kick"] = { ...surface.affordances["affordance:kick"] as object, project_result: (input: unknown) => hooks.projectResult!(input, dynamics) };
  }
  surface.affordances["affordance:wait"] = { ...surface.affordances["affordance:kick"] as object, dynamics_action: "wait", target_selector: { kind: "holder" } };
  const surfaceRegistry = parseWorldSurfaceDefinition(surface);
  const redPrincipal = identity.redPrincipal ?? "principal-red";
  const boundGrants = issueBoundWorldGrants([
    { participant: "blue", principal: "principal-blue", entity: "world://pitch/entity/blue", senses: ["world://pitch/sense/blue-view"], affordances: ["world://pitch/affordance/wait"] },
    { participant: "red", principal: redPrincipal, entity: "world://pitch/entity/red", senses: identity.redSenses ?? ["world://pitch/sense/vision", "world://pitch/sense/red-detail"], affordances: identity.redAffordances ?? ["world://pitch/affordance/kick", "world://pitch/affordance/wait"] },
  ] as const as never);
  const capabilityManifests = compileCapabilityManifests({ runId: identity.runId, worldInstanceId: identity.worldInstanceId, world: { id: "pitch" as never }, surfaceRegistry, grants: boundGrants as never });
  let entropy = 9;
  const decisionRegistry = createDecisionRegistryForTesting({ runId: identity.runId, worldInstanceId: identity.worldInstanceId, tokenDigestKey: new Uint8Array(32).fill(7) }, { randomBytes: hooks.randomBytes ?? (() => new Uint8Array(32).fill(entropy++)) });
  const validThroughTick = identity.decisionValidThroughTick ?? 2;
  const red = decisionRegistry.mint({ principal: redPrincipal, issuedTick: 0, validThroughTick });
  const blue = decisionRegistry.mint({ principal: "principal-blue", issuedTick: 0, validThroughTick });
  let calls = 0;
  let restores = 0;
  const providerState: Record<string, unknown> = { value: 0 };
  dynamics = createDynamicsSession({
    api_version: "simfile.dynamics-provider.v1", id: "runtime-test", version: "1", state_schema_version: "v1", integration: {},
    initialize: () => {},
    observe: (input) => {
      calls += 1;
      return (hooks.observe?.(input, providerState, dynamics) ?? {
        channels: input.sense_addresses.map((sense_address) => ({ components: { x: 1 }, sense_address, subject_address: "object:red", unit: "meters" })),
      }) as never;
    },
    restore: (value) => {
      restores += 1;
      if (hooks.failRestore?.()) throw new Error("configured real provider restore failure");
      Object.assign(providerState, value);
      for (const key of Object.keys(providerState)) if (!Object.hasOwn(value as object, key)) delete providerState[key];
    },
    snapshot: () => { hooks.snapshot?.(); return structuredClone(providerState) as never; },
    step: (input) => { calls += 1; return (hooks.step?.(input, providerState, dynamics) ?? { action_results: [], events: [], tick: input.tick }) as never; },
  }, {
    buildReceipt: identity.buildReceiptSha256 === undefined ? {} : { receiptSha256: identity.buildReceiptSha256 }, config: {}, seed: "seed", simSecondsPerTick: 1,
    provenance: { api_version: "simfile.dynamics-provider.v1", config_sha256: "0".repeat(64), module: "test", module_sha256: identity.moduleSha256 ?? "1".repeat(64), node_version: "test", numeric_model: "ieee754-binary64", provider_dependencies: {}, provider_id: "runtime-test", provider_version: "1", state_schema_version: "v1" },
  } as never);
  const readLedger = createWorldReadLedger({
    maxEntriesPerPrincipal: 20,
    ...(identity.maxLedgerPrincipals === undefined ? {} : { maxPrincipals: identity.maxLedgerPrincipals }),
  });
  const runtime = createRuntime ? createWorldRuntime({ dynamics, surfaceRegistry, capabilityManifests, boundGrants, decisionRegistry, readLedger }) : undefined;
  return { runtime, dynamics, dynamicsCalls: () => calls, restoreCalls: () => restores, surfaceRegistry, capabilityManifests, boundGrants, decisionRegistry, readLedger, red, blue };
};
