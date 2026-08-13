import { types } from "node:util";

export const WORLD_SIDECAR_CLOCK_VERSION = "simfile.world-sidecar-clock.v1" as const;
export const WORLD_SIDECAR_CLOCK_PATH = "/v1/world/clock" as const;

export interface WorldSidecarClockObservation {
  readonly action_count: number;
  readonly clock: Readonly<{
    readonly completed_tick: number;
    readonly next_tick: number;
    readonly state: "running";
  }>;
  readonly run_id: string;
  readonly version: typeof WORLD_SIDECAR_CLOCK_VERSION;
  readonly world_instance_id: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const fail = (): never => { throw new TypeError("world sidecar clock observation is invalid"); };

const exact = (raw: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((descriptor) =>
    !descriptor.enumerable || !("value" in descriptor))) return fail();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
};

export const parseWorldSidecarClockObservation = (
  raw: unknown,
): WorldSidecarClockObservation => {
  const value = exact(raw, ["action_count", "clock", "run_id", "version", "world_instance_id"]);
  const clock = exact(value.clock, ["completed_tick", "next_tick", "state"]);
  if (value.version !== WORLD_SIDECAR_CLOCK_VERSION
    || typeof value.run_id !== "string" || !RUN_ID.test(value.run_id)
    || typeof value.world_instance_id !== "string" || !RUN_ID.test(value.world_instance_id)
    || !Number.isSafeInteger(value.action_count) || (value.action_count as number) < 0
    || !Number.isSafeInteger(clock.completed_tick) || (clock.completed_tick as number) < 0
    || !Number.isSafeInteger(clock.next_tick)
    || clock.next_tick !== (clock.completed_tick as number) + 1
    || clock.state !== "running") return fail();
  return Object.freeze({
    action_count: value.action_count as number,
    clock: Object.freeze({
      completed_tick: clock.completed_tick as number,
      next_tick: clock.next_tick as number,
      state: "running" as const,
    }),
    run_id: value.run_id,
    version: WORLD_SIDECAR_CLOCK_VERSION,
    world_instance_id: value.world_instance_id,
  });
};

export const createWorldSidecarClockObservation = (
  raw: Omit<WorldSidecarClockObservation, "version"> & { readonly version?: typeof WORLD_SIDECAR_CLOCK_VERSION },
): WorldSidecarClockObservation => parseWorldSidecarClockObservation({
  ...raw, version: WORLD_SIDECAR_CLOCK_VERSION,
});
