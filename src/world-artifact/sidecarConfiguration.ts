import type { Server } from "node:http";
import { types } from "node:util";

import { compareUtf16 } from "../dynamics/buildIdentity.js";
import type { CreateWorldRuntimeInput, WorldRuntime } from "../world/runtime.js";
import { parseSimfileScopedSecretIdentifier, type WorldSidecarBearerDeclaration } from "./secretMount.js";
import { parseWorldSidecarAbsolutePath } from "./sidecarPath.js";

export const WORLD_SIDECAR_RUNTIME_ABI = "simfile.world-sidecar-runtime.v1" as const;
export type { WorldSidecarBearerDeclaration } from "./secretMount.js";

export interface WorldSidecarConfiguration {
  readonly runtime_abi: typeof WORLD_SIDECAR_RUNTIME_ABI;
  readonly network: Readonly<{ readonly dns_alias: string; readonly internal_port: number }>;
  readonly evidence_root: string;
  readonly secret_root: string;
  readonly bearer_declarations: readonly WorldSidecarBearerDeclaration[];
  readonly bundle_digest: string;
  readonly activation_bundle_digest?: string;
}
export interface StartedWorldSidecar { readonly server: Server; close(): Promise<void>; }
export interface WorldSidecarController { close(): Promise<void>; }
export interface WorldSidecarActivation { readonly ready: Promise<void>; }
export type StartWorldSidecarController = (
  runtime: WorldRuntime,
  activation: WorldSidecarActivation,
) => WorldSidecarController | Promise<WorldSidecarController>;
export type ProveWorldSidecarReadiness = (
  disposableRuntime: WorldRuntime,
) => void | Promise<void>;
export type ComposeWorldRuntime = () =>
  CreateWorldRuntimeInput | Promise<CreateWorldRuntimeInput>;

const invalid = (): never => {
  throw new TypeError("invalid world service entrypoint configuration");
};
const text = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && value.length > 0
    && value.length <= maximum && value === value.trim() ? value : undefined;
const digest = (value: unknown): string | undefined =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value : undefined;
const exactData = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return invalid();
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    output[field] = descriptor.value;
  }
  return output;
};

export const parseWorldSidecarConfiguration = (value: unknown): WorldSidecarConfiguration => {
  const activationDescriptor = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "activation_bundle_digest")
    : undefined;
  const allFields = [
    "runtime_abi", "network", "evidence_root", "secret_root",
    "bearer_declarations", "bundle_digest", "activation_bundle_digest",
  ] as const;
  const input = exactData(value, activationDescriptor === undefined
    ? allFields.slice(0, -1) : allFields);
  const network = exactData(input.network, ["dns_alias", "internal_port"]);
  const dnsAlias = text(network.dns_alias, 128);
  const port = network.internal_port;
  let evidenceRoot: string;
  let secretRoot: string;
  try {
    evidenceRoot = parseWorldSidecarAbsolutePath(input.evidence_root);
    secretRoot = parseWorldSidecarAbsolutePath(input.secret_root);
  } catch { return invalid(); }
  if (input.runtime_abi !== WORLD_SIDECAR_RUNTIME_ABI || !dnsAlias
    || !/^[a-z][a-z0-9-]{0,62}$/u.test(dnsAlias)
    || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535
    || !digest(input.bundle_digest)
    || input.activation_bundle_digest !== undefined && !digest(input.activation_bundle_digest)) {
    return invalid();
  }
  if (!Array.isArray(input.bearer_declarations) || types.isProxy(input.bearer_declarations)
    || Object.getPrototypeOf(input.bearer_declarations) !== Array.prototype
    || input.bearer_declarations.length < 1 || input.bearer_declarations.length > 64
    || Reflect.ownKeys(input.bearer_declarations).length
      !== input.bearer_declarations.length + 1) return invalid();
  const declarations: WorldSidecarBearerDeclaration[] = [];
  for (let index = 0; index < input.bearer_declarations.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.bearer_declarations, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    const record = exactData(descriptor.value, ["scope", "name", "principal"]);
    const scope = parseSimfileScopedSecretIdentifier(record.scope);
    const name = parseSimfileScopedSecretIdentifier(record.name);
    const principal = text(record.principal, 256);
    if (!scope || !name || !principal) return invalid();
    declarations.push(Object.freeze({ scope, name, principal }));
  }
  if (declarations.some((item, index) => index > 0
    && (compareUtf16(declarations[index - 1]!.scope, item.scope) > 0
      || declarations[index - 1]!.scope === item.scope
        && compareUtf16(declarations[index - 1]!.name, item.name) >= 0))
    || new Set(declarations.map((item) => `${item.scope}\0${item.name}`)).size
      !== declarations.length
    || new Set(declarations.map((item) => item.principal)).size !== declarations.length) {
    return invalid();
  }
  return Object.freeze({
    runtime_abi: WORLD_SIDECAR_RUNTIME_ABI,
    network: Object.freeze({ dns_alias: dnsAlias, internal_port: port }),
    evidence_root: evidenceRoot,
    secret_root: secretRoot,
    bearer_declarations: Object.freeze(declarations),
    bundle_digest: input.bundle_digest as string,
    ...(input.activation_bundle_digest === undefined
      ? {} : { activation_bundle_digest: input.activation_bundle_digest as string }),
  });
};
