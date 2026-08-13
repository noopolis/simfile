import { copyWorldCheckpointSnapshot, type WorldCheckpointSnapshot, type WorldCheckpointStatic } from "./checkpointSnapshot.js";
import { validateWorldCheckpointRelations } from "./checkpointRelations.js";

export const WORLD_CHECKPOINT_VERSION = "simfile.world-checkpoint.v1" as const;
export interface WorldCheckpoint extends WorldCheckpointSnapshot {
  readonly version: typeof WORLD_CHECKPOINT_VERSION;
}
export type { WorldCheckpointStatic } from "./checkpointSnapshot.js";

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
};
const compose = (snapshot: WorldCheckpointSnapshot): WorldCheckpoint => deepFreeze({ version: WORLD_CHECKPOINT_VERSION, ...snapshot });

export const parseWorldCheckpoint = (input: unknown): WorldCheckpoint | undefined => {
  try {
    const snapshot = copyWorldCheckpointSnapshot(input);
    if (snapshot === undefined || !validateWorldCheckpointRelations(snapshot)) return undefined;
    return compose(snapshot);
  } catch { return undefined; }
};

export const cloneWorldCheckpoint = (input: WorldCheckpoint): WorldCheckpoint => {
  const parsed = parseWorldCheckpoint(input);
  if (parsed === undefined) throw new TypeError("invalid world checkpoint");
  return parsed;
};
