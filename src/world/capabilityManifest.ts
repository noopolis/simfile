import { types } from "node:util";
import { Buffer } from "node:buffer";

import { canonicalJson, compareUtf16, deepFreeze, sha256 } from "../dynamics/buildIdentity.js";
import {
  assertNoWorldActionSchemaAuthorityFields,
  assertNoWorldAuthoritySchemaFields,
  parseBoundedJsonSchema,
  WORLD_SURFACE_API_VERSION,
  type WorldSurfaceRegistry
} from "../world-surface/index.js";
import { readParsedWorldSurfaceRegistry } from "../world-surface/definition.js";
import { parseSimfileIdentifier } from "../schema/identifier.js";
import {
  parseLocalResourceReference,
  parseWorldId,
  resolveWorldAddress,
  type CanonicalWorldAddress,
  type WorldId,
  type WorldResourceKind
} from "./addresses.js";
import type { BoundWorldGrant } from "./grants.js";

export const CAPABILITY_MANIFEST_VERSION = "simfile.capability-manifest.v1" as const;

export interface CapabilityManifestCompilationInput {
  readonly runId: string;
  readonly worldInstanceId: string;
  readonly world: { readonly id: WorldId; readonly ancestors?: never };
  readonly surfaceRegistry: WorldSurfaceRegistry;
  readonly grants: readonly BoundWorldGrant[];
}

export interface CapabilityManifest {
  readonly version: typeof CAPABILITY_MANIFEST_VERSION;
  readonly run_id: string;
  readonly world: { readonly id: string; readonly instance_id: string };
  readonly holder: { readonly principal: string; readonly entity: CanonicalWorldAddress };
  readonly surface: { readonly api_version: typeof WORLD_SURFACE_API_VERSION; readonly registry_digest: string };
  readonly senses: readonly { readonly address: CanonicalWorldAddress; readonly output: "simfile.numeric-observation.v1"; readonly output_schema_digest: string }[];
  readonly affordances: readonly {
    readonly address: CanonicalWorldAddress;
    readonly input_schema: Readonly<Record<string, unknown>>;
    readonly input_schema_digest: string;
    readonly rejection_codes: readonly string[];
    readonly target_selector: { readonly kind: "holder" } | { readonly kind: "fixed"; readonly targets: readonly CanonicalWorldAddress[] };
  }[];
  readonly manifest_digest: string;
}

export interface CapabilityManifestArtifact { readonly manifest: CapabilityManifest; readonly bytes: readonly number[]; readonly digest: string; }

type JsonRecord = Record<string, unknown>;
type Selector = CapabilityManifest["affordances"][number]["target_selector"];
type ResourceMaps = {
  readonly entities: ReadonlySet<CanonicalWorldAddress>;
  readonly senses: ReadonlyMap<CanonicalWorldAddress, { readonly address: CanonicalWorldAddress; readonly output: "simfile.numeric-observation.v1" }>;
  readonly affordances: ReadonlyMap<CanonicalWorldAddress, { readonly address: CanonicalWorldAddress; readonly input_schema: Readonly<Record<string, unknown>>; readonly rejection_codes: readonly string[]; readonly target_selector: Selector }>;
  readonly descriptor: unknown;
};

const UTF8 = new TextEncoder();
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length"
)!.get as (this: Uint8Array) => number;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const DOMAINS = { input: "simfile.capability-input-schema.v1\0", manifest: "simfile.capability-manifest.v1\0", output: "simfile.capability-output-schema.v1\0", registry: "simfile.world-surface-registry.v1\0" } as const;
const fail = (message: string): never => { throw new TypeError(`Capability manifest rejected: ${message}`); };
const reject = (message: string): never => fail(message);
const bytes = (value: unknown): Uint8Array => UTF8.encode(`${canonicalJson(value)}\n`);
const digest = (domain: string, value: unknown): string => `sha256:${sha256(UTF8.encode(domain + new TextDecoder().decode(bytes(value))))}`;

const isProxy = (value: unknown): boolean => value !== null && typeof value === "object" && types.isProxy(value as object);
const objectValues = (value: unknown, path: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) fail(`${path} has unsafe data`);
  const source = value as object; const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  const output = Object.create(null) as JsonRecord;
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) fail(`${path} has unsafe data`);
    Object.defineProperty(output, key, { configurable: true, enumerable: true, value: (descriptor as PropertyDescriptor & { value: unknown }).value, writable: true });
  }
  return output;
};
const record = (value: unknown, fields: readonly string[], path: string): JsonRecord => {
  const output = objectValues(value, path); const keys = Object.keys(output);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)) || fields.some((field) => !Object.hasOwn(output, field))) fail(`${path} has an invalid shape`);
  return output;
};
const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${path} must be a plain array`);
  const source = value as unknown[]; const length = Object.getOwnPropertyDescriptor(source, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value)) fail(`${path} has unsafe data`);
  const count = (length as PropertyDescriptor & { value: number }).value;
  const output: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path} has unsafe data`);
    output.push((descriptor as PropertyDescriptor & { value: unknown }).value);
  }
  if (Reflect.ownKeys(source).length !== count + 1) fail(`${path} has unsafe data`);
  return output;
};
const json = (value: unknown, path: string): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(`${path} must be JSON`); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) return array(value, path).map((entry, index) => json(entry, `${path}[${index}]`));
  const source = objectValues(value, path); const output = Object.create(null) as JsonRecord;
  for (const [key, child] of Object.entries(source)) Object.defineProperty(output, key, { configurable: true, enumerable: true, value: json(child, `${path}.${key}`), writable: true });
  return output;
};
const schema = (
  value: unknown,
  path: string,
  assertAuthority: (schema: ReturnType<typeof parseBoundedJsonSchema>, path: string) => void =
    assertNoWorldAuthoritySchemaFields
): Readonly<Record<string, unknown>> => {
  try {
    const parsed = parseBoundedJsonSchema(json(value, path));
    assertAuthority(parsed, path);
    return parsed as unknown as Readonly<Record<string, unknown>>;
  } catch { return fail(`${path} is invalid`); }
};
const binding = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) fail(`${path} must be a non-empty binding`);
  return value as string;
};
const sorted = <Value extends { readonly address: string }>(value: readonly Value[], path: string): readonly Value[] => {
  for (let index = 1; index < value.length; index += 1) if (compareUtf16(value[index - 1]!.address, value[index]!.address) >= 0) fail(`${path} is not strictly address-ordered`);
  return value;
};
const absolute = (worldId: string, value: unknown, kinds: readonly WorldResourceKind[], path: string): CanonicalWorldAddress => {
  if (typeof value !== "string") fail(`${path} must be an absolute world address`);
  const address = value as string;
  for (const kind of kinds) {
    const prefix = `world://${worldId}/${kind}/`;
    if (!address.startsWith(prefix)) continue;
    try {
      const resolved = resolveWorldAddress({ id: parseWorldId(worldId) }, parseLocalResourceReference(`${kind}:${address.slice(prefix.length)}`));
      if (resolved === address) return resolved;
    } catch { /* Address grammar owns its diagnostics. */ }
  }
  return fail(`${path} is not a canonical address of the required kind`);
};
const selector = (worldId: string, value: unknown, path: string): Selector => {
  const shape = objectValues(value, path); const input = record(value, shape.kind === "fixed" ? ["kind", "targets"] : ["kind"], path);
  if (input.kind === "holder") return deepFreeze({ kind: "holder" });
  if (input.kind !== "fixed") fail(`${path} is invalid`);
  const targets = array(input.targets, `${path}.targets`).map((target, index) => absolute(worldId, target, ["entity"], `${path}.targets[${index}]`));
  if (targets.length === 0 || new Set(targets).size !== targets.length) fail(`${path} is invalid`);
  return deepFreeze({ kind: "fixed", targets: [...targets].sort(compareUtf16) });
};

const resourceMaps = (worldId: string, source: WorldSurfaceRegistry): ResourceMaps => {
  const entities = new Set<CanonicalWorldAddress>();
  const senses = new Map<CanonicalWorldAddress, { address: CanonicalWorldAddress; output: "simfile.numeric-observation.v1" }>();
  const affordances = new Map<CanonicalWorldAddress, { address: CanonicalWorldAddress; input_schema: Readonly<Record<string, unknown>>; rejection_codes: readonly string[]; target_selector: Selector }>();
  const entityDescriptor = source.entities.map((entry) => { const address = resolveWorldAddress({ id: parseWorldId(worldId) }, entry.address); entities.add(address); return { address, alias: entry.alias, dynamics_address: entry.dynamics_address }; }).sort((a, b) => compareUtf16(a.address, b.address));
  const senseDescriptor = source.senses.map((entry) => { const address = resolveWorldAddress({ id: parseWorldId(worldId) }, entry.address); const item = { address, output: entry.output }; senses.set(address, item); return { ...item, dynamics_senses: [...entry.dynamics_senses] }; }).sort((a, b) => compareUtf16(a.address, b.address));
  const affordanceDescriptor = source.affordances.map((entry) => {
    const address = resolveWorldAddress({ id: parseWorldId(worldId) }, entry.address); const inputSchema = schema(entry.input_schema, "checked affordance schema", assertNoWorldActionSchemaAuthorityFields);
    const target = entry.target_selector.kind === "holder" ? deepFreeze({ kind: "holder" } as const) : deepFreeze({ kind: "fixed" as const, targets: entry.target_selector.targets.map((item) => resolveWorldAddress({ id: parseWorldId(worldId) }, item)).sort(compareUtf16) });
    const item = { address, input_schema: inputSchema, rejection_codes: [...entry.rejection_codes].sort(compareUtf16), target_selector: target as Selector };
    affordances.set(address, item); return { ...item, dynamics_action: entry.dynamics_action };
  }).sort((a, b) => compareUtf16(a.address, b.address));
  const effects = source.effects.map((entry) => ({ address: resolveWorldAddress({ id: parseWorldId(worldId) }, entry.address), dynamics_event: entry.dynamics_event, payload_schema: schema(entry.payload_schema, "checked effect schema") })).sort((a, b) => compareUtf16(a.address, b.address));
  return { entities, senses, affordances, descriptor: { api_version: WORLD_SURFACE_API_VERSION, entities: entityDescriptor, senses: senseDescriptor, affordances: affordanceDescriptor, effects } };
};

const validate = (value: unknown): CapabilityManifest => {
  const source = record(value, ["version", "run_id", "world", "holder", "surface", "senses", "affordances", "manifest_digest"], "manifest");
  if (source.version !== CAPABILITY_MANIFEST_VERSION) fail("version is invalid");
  const runId = binding(source.run_id, "run_id"); const world = record(source.world, ["id", "instance_id"], "world"); const worldId = parseWorldId(world.id); const instanceId = binding(world.instance_id, "world.instance_id");
  const holder = record(source.holder, ["principal", "entity"], "holder"); const principal = binding(holder.principal, "holder.principal"); const entity = absolute(worldId, holder.entity, ["entity"], "holder.entity");
  const surface = record(source.surface, ["api_version", "registry_digest"], "surface"); if (surface.api_version !== WORLD_SURFACE_API_VERSION || typeof surface.registry_digest !== "string" || !SHA256.test(surface.registry_digest)) fail("surface is invalid");
  const senses = array(source.senses, "senses").map((entry, index) => { const item = record(entry, ["address", "output", "output_schema_digest"], `senses[${index}]`); const address = absolute(worldId, item.address, ["sense"], `senses[${index}].address`); if (item.output !== "simfile.numeric-observation.v1" || item.output_schema_digest !== digest(DOMAINS.output, { output: item.output })) fail(`senses[${index}] digest is invalid`); return { address, output: item.output as "simfile.numeric-observation.v1", output_schema_digest: item.output_schema_digest as string }; });
  sorted(senses, "senses");
  const affordances = array(source.affordances, "affordances").map((entry, index) => { const item = record(entry, ["address", "input_schema", "input_schema_digest", "rejection_codes", "target_selector"], `affordances[${index}]`); const address = absolute(worldId, item.address, ["affordance"], `affordances[${index}].address`); const inputSchema = schema(item.input_schema, `affordances[${index}].input_schema`, assertNoWorldActionSchemaAuthorityFields); if (item.input_schema_digest !== digest(DOMAINS.input, inputSchema)) fail(`affordances[${index}] digest is invalid`); const codes = array(item.rejection_codes, `affordances[${index}].rejection_codes`).map((code) => binding(code, `affordances[${index}].rejection_codes`)); if (new Set(codes).size !== codes.length || [...codes].sort(compareUtf16).some((code, codeIndex) => code !== codes[codeIndex])) fail(`affordances[${index}] rejection codes are not canonical`); return { address, input_schema: inputSchema, input_schema_digest: item.input_schema_digest as string, rejection_codes: codes, target_selector: selector(worldId, item.target_selector, `affordances[${index}].target_selector`) }; });
  sorted(affordances, "affordances");
  const core = { version: CAPABILITY_MANIFEST_VERSION, run_id: runId, world: { id: worldId, instance_id: instanceId }, holder: { principal, entity }, surface: { api_version: WORLD_SURFACE_API_VERSION, registry_digest: surface.registry_digest }, senses, affordances };
  if (typeof source.manifest_digest !== "string" || source.manifest_digest !== digest(DOMAINS.manifest, core)) fail("manifest digest is invalid");
  return deepFreeze({ ...core, manifest_digest: source.manifest_digest }) as CapabilityManifest;
};

const serialize = (manifest: CapabilityManifest): readonly number[] => deepFreeze(Array.from(bytes(validate(manifest))));
export const serializeCapabilityManifest = (manifest: CapabilityManifest): readonly number[] => { try { return serialize(manifest); } catch { return reject("invalid manifest"); } };

const compile = (input: CapabilityManifestCompilationInput): readonly CapabilityManifestArtifact[] => {
  const source = record(input, ["runId", "worldInstanceId", "world", "surfaceRegistry", "grants"], "compilation input"); const runId = binding(source.runId, "runId"); const instanceId = binding(source.worldInstanceId, "worldInstanceId");
  const scope = record(source.world, ["id"], "world"); const worldId = parseWorldId(scope.id); const checked = readParsedWorldSurfaceRegistry(source.surfaceRegistry); if (checked === undefined) fail("surface registry is not a parsed checked registry"); const registry = checked;
  const maps = resourceMaps(worldId, registry as WorldSurfaceRegistry); const registryDigest = digest(DOMAINS.registry, maps.descriptor); const principals = new Set<string>(); const participants = new Set<string>(); const artifacts: CapabilityManifestArtifact[] = [];
  for (const [index, rawGrant] of array(source.grants, "grants").entries()) {
    const grant = record(rawGrant, ["participant", "principal", "entity", "senses", "affordances"], `grants[${index}]`); const participant = parseSimfileIdentifier(grant.participant); const principal = binding(grant.principal, `grants[${index}].principal`);
    if (participants.has(participant) || principals.has(principal)) fail(`grants[${index}] duplicates participant or principal`); participants.add(participant); principals.add(principal);
    const entity = absolute(worldId, grant.entity, ["entity"], `grants[${index}].entity`); if (!maps.entities.has(entity)) fail(`grants[${index}] entity is undeclared`);
    const granted = (value: unknown, kind: "sense" | "affordance", path: string): readonly CanonicalWorldAddress[] => { const output = array(value, path).map((address, entryIndex) => absolute(worldId, address, [kind], `${path}[${entryIndex}]`)); if (new Set(output).size !== output.length) fail(`${path} contains duplicates`); return output.sort(compareUtf16); };
    const senses = granted(grant.senses, "sense", `grants[${index}].senses`).map((address) => { const definition = maps.senses.get(address); if (definition === undefined) return fail(`grants[${index}] sense is undeclared`); return { ...definition, output_schema_digest: digest(DOMAINS.output, { output: definition.output }) }; });
    const affordances = granted(grant.affordances, "affordance", `grants[${index}].affordances`).map((address) => { const definition = maps.affordances.get(address); if (definition === undefined) return fail(`grants[${index}] affordance is undeclared`); return { ...definition, input_schema_digest: digest(DOMAINS.input, definition.input_schema) }; });
    const core = { version: CAPABILITY_MANIFEST_VERSION, run_id: runId, world: { id: worldId, instance_id: instanceId }, holder: { principal, entity }, surface: { api_version: WORLD_SURFACE_API_VERSION, registry_digest: registryDigest }, senses, affordances };
    const manifest = validate({ ...core, manifest_digest: digest(DOMAINS.manifest, core) }); artifacts.push(deepFreeze({ manifest, bytes: serialize(manifest), digest: manifest.manifest_digest }));
  }
  return deepFreeze(artifacts.sort((left, right) => compareUtf16(left.manifest.holder.principal, right.manifest.holder.principal)));
};
export const compileCapabilityManifests = (input: CapabilityManifestCompilationInput): readonly CapabilityManifestArtifact[] => { try { return compile(input); } catch { return reject("invalid compilation input"); } };

const assertNoDuplicateKeys = (text: string): void => {
  let index = 0; const white = () => { while (/\s/u.test(text[index] ?? "")) index += 1; };
  const string = (): string => { const start = index++; let escaped = false; while (index < text.length) { const char = text[index++]!; if (!escaped && char === "\"") return JSON.parse(text.slice(start, index)) as string; escaped = !escaped && char === "\\"; if (char !== "\\") escaped = false; } return fail("unterminated JSON string"); };
  const value = (): void => { white(); const char = text[index]; if (char === "\"") { string(); return; } if (char === "{") { index += 1; white(); const keys = new Set<string>(); if (text[index] === "}") { index += 1; return; } while (true) { white(); if (text[index] !== "\"") fail("invalid JSON object"); const key = string(); if (keys.has(key)) fail("duplicate JSON key"); keys.add(key); white(); if (text[index++] !== ":") fail("invalid JSON object"); value(); white(); if (text[index] === "}") { index += 1; return; } if (text[index++] !== ",") fail("invalid JSON object"); } } if (char === "[") { index += 1; white(); if (text[index] === "]") { index += 1; return; } while (true) { value(); white(); if (text[index] === "]") { index += 1; return; } if (text[index++] !== ",") fail("invalid JSON array"); } } while (index < text.length && !/[\s,}\]]/u.test(text[index]!)) index += 1; };
  value(); white(); if (index !== text.length) fail("invalid JSON trailing content");
};
const wireBytes = (input: readonly number[] | Uint8Array): Uint8Array => {
  if (isProxy(input)) fail("bytes must not be a proxy");
  if (typeof input === "object" && input !== null
    && (Object.getPrototypeOf(input) === Uint8Array.prototype
      || Object.getPrototypeOf(input) === Buffer.prototype)) {
    const nativeBytes = input as Uint8Array;
    const length = TYPED_ARRAY_LENGTH.call(nativeBytes);
    const output = new Uint8Array(length);
    TYPED_ARRAY_SET.call(output, nativeBytes);
    return output;
  }
  return Uint8Array.from(array(input, "bytes").map((byte) => { if (!Number.isInteger(byte)) fail("bytes must be octets"); const octet = byte as number; if (octet < 0 || octet > 255) fail("bytes must be octets"); return octet; }));
};
export const parseCapabilityManifest = (input: readonly number[] | Uint8Array): CapabilityManifest => {
  try {
    const raw = wireBytes(input); const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (text.length === 0 || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("bytes must have one final LF");
    const encoded = UTF8.encode(text); if (encoded.length !== raw.length || encoded.some((byte, index) => byte !== raw[index])) fail("bytes are not canonical UTF-8");
    assertNoDuplicateKeys(text.slice(0, -1)); let decoded: unknown; try { decoded = JSON.parse(text); } catch { return fail("bytes are not JSON"); }
    const manifest = validate(decoded); const canonical = serialize(manifest); if (canonical.length !== raw.length || canonical.some((byte, index) => byte !== raw[index])) fail("bytes are not canonical");
    return manifest;
  } catch { return reject("invalid manifest bytes"); }
};
