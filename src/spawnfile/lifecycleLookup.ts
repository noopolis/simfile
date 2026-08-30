import { z } from "zod";

import { assertSecretFreeComposedJson } from "../compose/json.js";
import { runSpawnfileProcess, type SpawnfileCliContext } from "./process.js";

const invocation = z.string().regex(/^lci_[a-z0-9][a-z0-9_-]{15,127}$/u);
const operation = z.enum(["up", "artifacts_export", "down"]);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const version = z.literal("spawnfile.lifecycle-lookup.v1");
const lookup = z.discriminatedUnion("status", [
  z.object({ invocation_id: invocation, status: z.literal("not_applied"), version }).strict(),
  z.object({ invocation_digest: digest, operation, status: z.literal("pending"), version }).strict(),
  z.object({ invocation_digest: digest, operation,
    reason_code: z.enum(["reconciliation_ambiguous", "recovery_owner_died"]),
    status: z.literal("ambiguous"), version }).strict(),
  z.object({ invocation_digest: digest, operation,
    outcome_bytes: z.string().min(1).max(1_000_000),
    status: z.literal("completed"), version }).strict(),
]);

export type SpawnfileLifecycleOperation = z.infer<typeof operation>;
export type SpawnfileLifecycleLookup =
  | Readonly<{ invocation_id: string; status: "not_applied" }>
  | Readonly<{ invocation_digest: `sha256:${string}`;
      operation: SpawnfileLifecycleOperation; status: "pending" }>
  | Readonly<{ invocation_digest: `sha256:${string}`;
      operation: SpawnfileLifecycleOperation;
      reason_code: "reconciliation_ambiguous" | "recovery_owner_died";
      status: "ambiguous" }>
  | Readonly<{ invocation_digest: `sha256:${string}`;
      operation: SpawnfileLifecycleOperation; outcome: unknown; status: "completed" }>;

export const parseSpawnfileLifecycleLookup = (raw: unknown, input: Readonly<{
  invocation_id: string;
  operation: SpawnfileLifecycleOperation;
}>): SpawnfileLifecycleLookup => {
  assertSecretFreeComposedJson(raw);
  const value = lookup.parse(raw);
  if (value.status === "not_applied") {
    if (value.invocation_id !== input.invocation_id) {
      throw new TypeError("Spawnfile lifecycle lookup invocation changed");
    }
    return Object.freeze({ invocation_id: value.invocation_id, status: value.status });
  }
  if (value.operation !== input.operation) {
    throw new TypeError("Spawnfile lifecycle lookup operation changed");
  }
  if (value.status === "completed") {
    let outcome: unknown;
    try { outcome = JSON.parse(value.outcome_bytes) as unknown; }
    catch { throw new TypeError("Spawnfile lifecycle outcome is invalid JSON"); }
    assertSecretFreeComposedJson(outcome);
    return Object.freeze({ invocation_digest: value.invocation_digest as `sha256:${string}`,
      operation: value.operation, outcome, status: value.status });
  }
  return Object.freeze({ invocation_digest: value.invocation_digest as `sha256:${string}`,
    operation: value.operation,
    ...(value.status === "ambiguous" ? { reason_code: value.reason_code } : {}),
    status: value.status }) as SpawnfileLifecycleLookup;
};

export const runSpawnfileLifecycleLookup = async (
  context: SpawnfileCliContext,
  input: Readonly<{ invocation_id: string;
    operation: SpawnfileLifecycleOperation; signal?: AbortSignal }>,
): Promise<SpawnfileLifecycleLookup> => {
  invocation.parse(input.invocation_id);
  const result = await runSpawnfileProcess(context, {
    args: ["lifecycle", "lookup", input.invocation_id], signal: input.signal,
  });
  let raw: unknown;
  try { raw = JSON.parse(result.stdout) as unknown; }
  catch { throw new TypeError("Spawnfile lifecycle lookup did not emit JSON"); }
  return parseSpawnfileLifecycleLookup(raw, input);
};

export const resolveSpawnfileLifecycleOutcome = async <Outcome>(input: Readonly<{
  invocation_id: string;
  invoke: () => Promise<Outcome>;
  lookup: () => Promise<SpawnfileLifecycleLookup>;
  operation: SpawnfileLifecycleOperation;
  parse: (raw: unknown) => Outcome;
}>): Promise<Outcome> => {
  const observed = await input.lookup();
  if (observed.status === "completed") return input.parse(observed.outcome);
  if (observed.status === "pending") {
    throw new TypeError(
      `Spawnfile ${input.operation} lifecycle ${input.invocation_id} remains pending`,
    );
  }
  if (observed.status === "ambiguous") {
    throw new TypeError(
      `Spawnfile ${input.operation} lifecycle ${input.invocation_id} is ambiguous (${observed.reason_code})`,
    );
  }
  return input.invoke();
};
