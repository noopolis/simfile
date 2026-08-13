import { isDeepStrictEqual } from "node:util";

import type { DynamicsSessionSnapshot } from "./types.js";

/** Compares snapshots already issued by a checked, resource-bounded session. */
export const sameDynamicsSessionSnapshot = (
  left: DynamicsSessionSnapshot,
  right: DynamicsSessionSnapshot,
): boolean => isDeepStrictEqual(left, right);
