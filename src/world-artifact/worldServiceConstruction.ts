import type { RequestListener } from "node:http";
import { types } from "node:util";

import {
  createWorldRuntime,
  WORLD_RUNTIME_INPUT_FIELDS,
  type CreateWorldRuntimeInput,
  type WorldRuntime,
} from "../world/runtime.js";
import {
  createWorldJsonRequestListener,
  createWorldJsonServer,
  createWorldMcpRequestListener,
  createWorldRequestHandler,
  type WorldBearerResolver,
  type WorldMcpRequestListener,
} from "../world-server/index.js";
import type { WorldSidecarCapability } from "./sidecarCapabilities.js";

export interface CreateWorldServiceEntrypointInput {
  readonly runtime_input: CreateWorldRuntimeInput;
  readonly resolveBearer: WorldBearerResolver;
}
export interface WorldServiceEntrypoint {
  readonly jsonListener: RequestListener;
  readonly mcpListener: WorldMcpRequestListener;
}
export interface ConstructedWorldServiceEntrypoint extends WorldServiceEntrypoint {
  readonly runtime: WorldRuntime;
}

export const invalidWorldServiceConfiguration = (): never => {
  throw new TypeError("invalid world service entrypoint configuration");
};

export const snapshotWorldRuntimeInput = (value: unknown): CreateWorldRuntimeInput => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidWorldServiceConfiguration();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== WORLD_RUNTIME_INPUT_FIELDS.length
    || keys.some((key) => typeof key !== "string"
      || !WORLD_RUNTIME_INPUT_FIELDS.includes(key as never))) {
    return invalidWorldServiceConfiguration();
  }
  const copied: Record<string, unknown> = {};
  const references = new Set<object>();
  for (const key of WORLD_RUNTIME_INPUT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)
      || descriptor.value === null || typeof descriptor.value !== "object"
      || types.isProxy(descriptor.value) || references.has(descriptor.value)) {
      return invalidWorldServiceConfiguration();
    }
    references.add(descriptor.value);
    copied[key] = descriptor.value;
  }
  return Object.freeze(copied) as unknown as CreateWorldRuntimeInput;
};

export const constructWorldServiceAdapters = (
  runtime: WorldRuntime,
  resolveBearer: WorldBearerResolver,
  capabilities: readonly WorldSidecarCapability[] = [],
): ConstructedWorldServiceEntrypoint => {
  const handler = createWorldRequestHandler({ runtime, resolveBearer, capabilities });
  const jsonServer = createWorldJsonServer({ handler });
  return Object.freeze({
    jsonListener: createWorldJsonRequestListener({ server: jsonServer }),
    mcpListener: createWorldMcpRequestListener({ handler }),
    runtime,
  });
};

export const constructWorldServiceEntrypoint = (
  input: CreateWorldServiceEntrypointInput,
): ConstructedWorldServiceEntrypoint => {
  if (input === null || typeof input !== "object" || types.isProxy(input)) {
    return invalidWorldServiceConfiguration();
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2
    || keys.some((key) => key !== "runtime_input" && key !== "resolveBearer")) {
    return invalidWorldServiceConfiguration();
  }
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(input, "runtime_input");
  const resolverDescriptor = Object.getOwnPropertyDescriptor(input, "resolveBearer");
  if (!runtimeDescriptor?.enumerable || !("value" in runtimeDescriptor)
    || !resolverDescriptor?.enumerable || !("value" in resolverDescriptor)
    || runtimeDescriptor.value === null || typeof runtimeDescriptor.value !== "object"
    || types.isProxy(runtimeDescriptor.value) || typeof resolverDescriptor.value !== "function"
    || types.isProxy(resolverDescriptor.value)) return invalidWorldServiceConfiguration();
  const runtimeInput = snapshotWorldRuntimeInput(runtimeDescriptor.value);
  const runtime = createWorldRuntime(runtimeInput);
  return constructWorldServiceAdapters(
    runtime,
    resolverDescriptor.value as WorldBearerResolver,
  );
};
