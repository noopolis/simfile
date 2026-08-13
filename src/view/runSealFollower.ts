import { access } from "node:fs/promises";
import path from "node:path";

import type { RunViewerExtensionIdentity } from "./runViewerExtensions.js";

export type RunSealFollowerState = Readonly<{
  error?: string;
  identities: readonly RunViewerExtensionIdentity[];
  status: "live" | "recorded" | "failed";
}>;

export interface RunSealFollower {
  awaitTerminal: (timeoutMs?: number) => Promise<RunSealFollowerState>;
  close: () => void;
  getState: () => RunSealFollowerState;
  subscribe: (listener: () => void) => () => void;
}

export interface RunSealFollowerOptions {
  readonly initialIdentities?: readonly RunViewerExtensionIdentity[];
  readonly pollMs?: number;
  readonly reconcileAtSeal?: () => Promise<readonly RunViewerExtensionIdentity[]>;
  readonly runDir: string;
}

const manifestPresent = async (runDir: string): Promise<boolean> => {
  try {
    await access(path.join(path.resolve(runDir), "manifest.json"));
    return true;
  } catch {
    return false;
  }
};

/** Owns seal reconciliation for the server, independent of browser/SSE use. */
export const startRunSealFollower = (
  options: RunSealFollowerOptions,
): RunSealFollower => {
  let state: RunSealFollowerState = Object.freeze({
    identities: options.initialIdentities ?? [],
    status: "live",
  });
  let closed = false;
  let polling = false;
  const listeners = new Set<() => void>();

  const publish = (next: RunSealFollowerState): void => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };

  const poll = async (): Promise<void> => {
    if (closed || polling || state.status !== "live") return;
    polling = true;
    try {
      if (!(await manifestPresent(options.runDir))) return;
      try {
        const identities = options.reconcileAtSeal
          ? await options.reconcileAtSeal()
          : state.identities;
        publish({ identities, status: "recorded" });
      } catch (error) {
        publish({
          error: error instanceof Error ? error.message : String(error),
          identities: state.identities,
          status: "failed",
        });
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), options.pollMs ?? 100);
  void poll();
  return Object.freeze({
    awaitTerminal: (timeoutMs = 5_000) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return Promise.reject(new TypeError("run seal wait timeout is invalid"));
      }
      if (state.status !== "live") return Promise.resolve(state);
      return new Promise<RunSealFollowerState>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("viewer seal reconciliation timed out"));
        }, timeoutMs);
        const unsubscribe = (() => {
          const listener = (): void => {
            if (state.status === "live") return;
            clearTimeout(timeout);
            listeners.delete(listener);
            resolve(state);
          };
          listeners.add(listener);
          return () => listeners.delete(listener);
        })();
      });
    },
    close: () => {
      closed = true;
      clearInterval(timer);
      listeners.clear();
    },
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
};
