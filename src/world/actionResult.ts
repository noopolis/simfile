import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { copyHostileJson, type HostileJson } from "./hostileJson.js";

export const WORLD_ACTION_RESULT_VERSION = "simfile.world-action-result.v1" as const;

export interface WorldActionResultIdentity {
  readonly run_id: string; readonly world_id: string; readonly world_instance_id: string;
  readonly manifest_digest: string; readonly state_version: number;
}
export interface WorldActionResultApplied {
  readonly version: typeof WORLD_ACTION_RESULT_VERSION; readonly result_id: string; readonly receipt_id: string;
  readonly decision_id: string; readonly actor: string; readonly action_sequence: number; readonly apply_tick: number;
  readonly status: "applied"; readonly caused_effect_ids: readonly string[]; readonly identity: WorldActionResultIdentity;
}
export interface WorldActionResultRejected {
  readonly version: typeof WORLD_ACTION_RESULT_VERSION; readonly result_id: string; readonly receipt_id: string;
  readonly decision_id: string; readonly actor: string; readonly action_sequence: number; readonly apply_tick: number;
  readonly status: "rejected_at_mechanics"; readonly rejection_code: string; readonly identity: WorldActionResultIdentity;
}
export type WorldActionResult = WorldActionResultApplied | WorldActionResultRejected;

const TEXT = DYNAMICS_LIMITS.identifier_code_units;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ADDRESS = /^world:\/\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)+entity\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const DECISION = /^decision-[0-9]{12}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const frozen = <T>(value: T): T => Object.freeze(value);
const safe = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= TEXT && value === value.trim();
const suffix = (value: unknown, prefix: string): number | undefined => {
  if (typeof value !== "string" || value.length > TEXT || !value.startsWith(prefix)) return undefined;
  const digits = value.slice(prefix.length);
  if (!/^[1-9][0-9]*$/u.test(digits)) return undefined;
  const number = Number(digits); return Number.isSafeInteger(number) ? number : undefined;
};
const decisionSequence = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !DECISION.test(value)) return undefined;
  const number = Number(value.slice("decision-".length)); return Number.isSafeInteger(number) && number >= 1 ? number : undefined;
};
const actor = (value: unknown, worldId: string): value is string => typeof value === "string"
  && ADDRESS.test(value) && value.startsWith(`world://${worldId}/entity/`);
const fields = (value: HostileJson, expected: readonly string[]): Readonly<Record<string, HostileJson>> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key)) && expected.every((key) => Object.hasOwn(value, key))
    ? value as Readonly<Record<string, HostileJson>> : undefined;
};

export const parseWorldActionResultIdentity = (value: unknown): WorldActionResultIdentity | undefined => {
  let copy: HostileJson; try { copy = copyHostileJson(value); } catch { return undefined; }
  const source = fields(copy, ["run_id", "world_id", "world_instance_id", "manifest_digest", "state_version"]);
  if (source === undefined || !text(source.run_id) || !text(source.world_id) || !text(source.world_instance_id)
    || typeof source.manifest_digest !== "string" || !SHA256.test(source.manifest_digest) || !safe(source.state_version, 0)) return undefined;
  return frozen({ run_id: source.run_id, world_id: source.world_id, world_instance_id: source.world_instance_id,
    manifest_digest: source.manifest_digest, state_version: source.state_version });
};
const effects = (value: HostileJson): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.length > DYNAMICS_LIMITS.events_per_tick) return undefined;
  const output: string[] = [];
  for (const entry of value) { if (suffix(entry, "world-effect-") === undefined) return undefined; output.push(entry as string); }
  return new Set(output).size === output.length ? frozen(output) : undefined;
};

/** Parses one complete, frozen terminal result; declared rejection ownership belongs to ledger admission. */
export const parseWorldActionResult = (value: unknown): WorldActionResult | undefined => {
  let copy: HostileJson; try { copy = copyHostileJson(value); } catch { return undefined; }
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return undefined;
  const status = (copy as Readonly<Record<string, HostileJson>>).status;
  const source = fields(copy, status === "applied"
    ? ["version", "result_id", "receipt_id", "decision_id", "actor", "action_sequence", "apply_tick", "status", "caused_effect_ids", "identity"]
    : status === "rejected_at_mechanics"
      ? ["version", "result_id", "receipt_id", "decision_id", "actor", "action_sequence", "apply_tick", "status", "rejection_code", "identity"] : []);
  if (source === undefined || source.version !== WORLD_ACTION_RESULT_VERSION || suffix(source.result_id, "world-result-") === undefined
    || suffix(source.receipt_id, "world-act-") === undefined || typeof source.decision_id !== "string" || !DECISION.test(source.decision_id)
    || decisionSequence(source.decision_id) === undefined || !safe(source.action_sequence, 1) || !safe(source.apply_tick, 0)
    || suffix(source.receipt_id, "world-act-") !== source.action_sequence) return undefined;
  const checkedIdentity = parseWorldActionResultIdentity(source.identity);
  if (checkedIdentity === undefined || !actor(source.actor, checkedIdentity.world_id)) return undefined;
  const base = { version: WORLD_ACTION_RESULT_VERSION, result_id: source.result_id as string, receipt_id: source.receipt_id as string, decision_id: source.decision_id,
    actor: source.actor, action_sequence: source.action_sequence, apply_tick: source.apply_tick, identity: checkedIdentity } as const;
  if (status === "applied") { const checked = effects(source.caused_effect_ids); return checked === undefined ? undefined : frozen({ ...base, status: "applied", caused_effect_ids: checked }); }
  return typeof source.rejection_code === "string" && CODE.test(source.rejection_code) ? frozen({ ...base, status: "rejected_at_mechanics", rejection_code: source.rejection_code }) : undefined;
};
