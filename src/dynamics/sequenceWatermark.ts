import { DYNAMICS_LIMITS } from "./limits.js";
import { issueDynamicsRetainedActionCapacityError } from "./retainedCapacity.js";
import type { DynamicsActionSequenceWatermark } from "./types.js";

export interface DynamicsActionSequenceIndex {
  add(sequence: number): void;
  addAll(sequences: readonly number[]): void;
  has(sequence: number): boolean;
  restore(value: DynamicsActionSequenceWatermark): void;
  snapshot(): DynamicsActionSequenceWatermark;
}

export const createDynamicsActionSequenceIndex = (
  initial: DynamicsActionSequenceWatermark = { floor: 1, above_floor: [] }
): DynamicsActionSequenceIndex => {
  let floor = initial.floor;
  let above = new Set(initial.above_floor);
  const addAll = (sequences: readonly number[]): void => {
    let nextFloor = floor;
    const nextAbove = new Set(above);
    for (const sequence of sequences) {
      if (sequence < nextFloor || nextAbove.has(sequence)) continue;
      if (sequence === nextFloor) {
        nextFloor += 1;
        while (nextAbove.delete(nextFloor)) nextFloor += 1;
      } else {
        if (nextAbove.size >= DYNAMICS_LIMITS.retained_action_records) {
          throw issueDynamicsRetainedActionCapacityError("records");
        }
        nextAbove.add(sequence);
      }
    }
    floor = nextFloor;
    above = nextAbove;
  };
  return {
    add: (sequence): void => addAll([sequence]),
    addAll,
    has: (sequence): boolean => sequence < floor || above.has(sequence),
    restore: (value): void => {
      floor = value.floor;
      above = new Set(value.above_floor);
    },
    snapshot: (): DynamicsActionSequenceWatermark => ({
      floor,
      above_floor: [...above].sort((left, right) => left - right)
    })
  };
};
