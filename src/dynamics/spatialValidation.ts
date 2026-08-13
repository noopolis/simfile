import { DYNAMICS_LIMITS } from "./limits.js";
import type { DynamicsSpatialFrame, DynamicsSpatialObject } from "./types.js";

/**
 * Validates a provider's optional per-tick spatial projection
 * (`DynamicsProvider.spatial()`), the one seam by which opaque
 * `provider_state` surfaces renderable motion to generic host code.
 *
 * `spatial()` is a THIRD projection of provider state, alongside `snapshot()`
 * (whose round-trip the session verifies) and `observe()` (which is
 * grant-gated). Nothing else forces it to agree with the state the record
 * seals, so everything checkable is checked here: shape, finiteness, id
 * uniqueness, and a hard object ceiling. Agreement with `snapshot()` is a
 * documented provider obligation, covered by a fixture test rather than by
 * the host.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rejects NaN and infinities, and normalizes `-0` to `0`. `JSON.stringify(-0)`
 * silently emits `0`, so an unnormalized `-0` would make an in-memory frame
 * and its recorded bytes disagree — a byte-identity trap rather than a
 * rendering one.
 */
const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value === 0 ? 0 : value;
};

const pair = (value: unknown, path: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${path} must be a two-number array`);
  }
  return [finiteNumber(value[0], `${path}[0]`), finiteNumber(value[1], `${path}[1]`)];
};

const parseObject = (value: unknown, path: string): DynamicsSpatialObject => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const id = value.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }
  if (id.length > DYNAMICS_LIMITS.identifier_code_units) {
    throw new Error(`${path}.id exceeds the identifier limit`);
  }
  return {
    id,
    position: pair(value.position, `${path}.position`),
    velocity: pair(value.velocity, `${path}.velocity`)
  };
};

export const parseDynamicsSpatialFrame = (
  value: unknown,
  path = "dynamics provider spatial()"
): DynamicsSpatialFrame => {
  if (!isRecord(value)) throw new Error(`${path} must return an object`);
  if (!Array.isArray(value.objects)) {
    throw new Error(`${path}.objects must be an array`);
  }
  if (value.objects.length > DYNAMICS_LIMITS.spatial_objects) {
    throw new Error(`${path}.objects exceeds the spatial object limit`);
  }
  const objects = value.objects.map((entry, index) =>
    parseObject(entry, `${path}.objects[${index}]`));
  const ids = new Set(objects.map((object) => object.id));
  if (ids.size !== objects.length) {
    throw new Error(`${path}.objects contains duplicate ids`);
  }

  if (value.bounds === undefined) return { objects };
  if (!isRecord(value.bounds)) throw new Error(`${path}.bounds must be an object`);
  const min = pair(value.bounds.min, `${path}.bounds.min`);
  const max = pair(value.bounds.max, `${path}.bounds.max`);
  if (!(max[0] > min[0]) || !(max[1] > min[1])) {
    throw new Error(`${path}.bounds must describe a positive-area extent`);
  }
  return { bounds: { max, min }, objects };
};
