import { types } from "node:util";

import type { Simfile } from "../schema/model.js";
import {
  parseWorldSurfaceDefinition,
  type WorldSurfaceRegistry
} from "../world-surface/index.js";
import type { LoadDynamicsSessionOptions } from "./loadCore.js";
import { loadDynamicsCore } from "./loadCore.js";
import {
  parseDynamicsRunActionSourceDeclaration,
  type DynamicsRunActionSourceDeclaration,
  type DynamicsRunActionSourceFactory,
  type DynamicsRunActionSourceInitialization
} from "./runActionSource.js";
import type { DynamicsSession } from "./session.js";

export interface LoadedDynamicsRun {
  readonly actionSource?: DynamicsRunActionSourceDeclaration;
  readonly session: DynamicsSession;
  readonly surfaceRegistry?: WorldSurfaceRegistry;
}

interface LoadedDynamicsRunExtensions {
  readonly actionSource?: DynamicsRunActionSourceDeclaration;
  readonly surfaceRegistry?: WorldSurfaceRegistry;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  types.isPromise(value)
  || (
    typeof value === "object"
    && value !== null
    && !types.isProxy(value)
    && (() => {
      let current: object | null = value;
      while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, "then");
        if (descriptor !== undefined) {
          return "value" in descriptor
            && typeof descriptor.value === "function";
        }
        current = Object.getPrototypeOf(current);
      }
      return false;
    })()
  );

const loadActionSource = (
  loaded: Record<string, unknown>,
  initialization: DynamicsRunActionSourceInitialization,
  simfile: Simfile
): DynamicsRunActionSourceDeclaration | undefined => {
  const rawFactory = loaded.createDynamicsRunActionSource;
  if (rawFactory === undefined) return undefined;
  if (typeof rawFactory !== "function") {
    throw new Error(
      "dynamics module createDynamicsRunActionSource export must be a function"
    );
  }
  const rawSource = (rawFactory as DynamicsRunActionSourceFactory)(
    initialization
  );
  if (isPromiseLike(rawSource)) {
    throw new Error("createDynamicsRunActionSource() must be synchronous");
  }
  if (rawSource === undefined) return undefined;
  return parseDynamicsRunActionSourceDeclaration(
    rawSource,
    new Set(Object.keys(simfile.world?.grants ?? {}))
  );
};

const loadSurfaceRegistry = (
  loaded: Record<string, unknown>
): WorldSurfaceRegistry | undefined => {
  const rawFactory = loaded.createWorldSurfaceDefinition;
  if (rawFactory === undefined) return undefined;
  if (typeof rawFactory !== "function") {
    throw new Error(
      "dynamics module createWorldSurfaceDefinition export must be a function"
    );
  }
  const rawSurface = rawFactory();
  if (isPromiseLike(rawSurface)) {
    throw new Error("createWorldSurfaceDefinition() must be synchronous");
  }
  return parseWorldSurfaceDefinition(rawSurface);
};

const loadRunExtensions = (
  loaded: Record<string, unknown>,
  initialization: DynamicsRunActionSourceInitialization,
  simfile: Simfile
): LoadedDynamicsRunExtensions => {
  const actionSource = loadActionSource(loaded, initialization, simfile);
  const surfaceRegistry = loadSurfaceRegistry(loaded);
  return Object.freeze({
    ...(actionSource === undefined ? {} : { actionSource }),
    ...(surfaceRegistry === undefined ? {} : { surfaceRegistry })
  });
};

export const loadDynamicsRunActionSource = async (
  simfile: Simfile,
  options: LoadDynamicsSessionOptions
): Promise<LoadedDynamicsRun | undefined> => {
  const loaded = await loadDynamicsCore(
    simfile,
    options,
    (artifact, initialization) =>
      loadRunExtensions(artifact, initialization, simfile)
  );
  if (loaded === undefined) return undefined;
  return {
    session: loaded.session,
    ...(loaded.extension.actionSource === undefined
      ? {}
      : { actionSource: loaded.extension.actionSource }),
    ...(loaded.extension.surfaceRegistry === undefined
      ? {}
      : { surfaceRegistry: loaded.extension.surfaceRegistry })
  };
};
