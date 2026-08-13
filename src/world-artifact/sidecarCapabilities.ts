import { types } from "node:util";

import { WORLD_DECISION_CLAIM_CAPABILITY } from "../world/decisionClaim.js";

export type WorldSidecarCapability = typeof WORLD_DECISION_CLAIM_CAPABILITY;

export const parseWorldSidecarCapabilities = (
  value: unknown,
): readonly WorldSidecarCapability[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1
    || value.length > 1) {
    throw new TypeError("invalid world sidecar capabilities");
  }
  const output: WorldSidecarCapability[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)
      || descriptor.value !== WORLD_DECISION_CLAIM_CAPABILITY) {
      throw new TypeError("invalid world sidecar capabilities");
    }
    output.push(descriptor.value);
  }
  if (new Set(output).size !== output.length) {
    throw new TypeError("invalid world sidecar capabilities");
  }
  return Object.freeze(output);
};
