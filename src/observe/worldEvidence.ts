import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CausalEvent } from "@noopolis/stele";

export interface WorldActionEvidence {
  action: string;
  origin: string | null;
  principal: string | null;
  has_decision_id: boolean;
}

export interface WorldEvidence {
  actions: { count: number; entries: WorldActionEvidence[] };
  perception: { count: number; principals: string[] };
  refusals: { count: number; reasons: string[] };
  possession: {
    changes_recorded: number;
    covered: boolean;
    first_change_tick?: number;
    last_change_tick?: number;
  };
  pace: {
    measured_wall_elapsed_seconds: number;
    declared_sim_seconds_per_tick: number;
    target_sim_seconds: number;
    kept_up: boolean;
  };
  verdict: { passed: boolean; status: "passed" | "failed" | "incomplete"; reasons: string[] };
}

export interface WorldEvidenceParseError {
  relativePath: string;
  line: number;
  message: string;
}

export interface WorldEvidenceReadResult {
  evidence?: WorldEvidence;
  parseErrors: WorldEvidenceParseError[];
}

type JsonRecord = Record<string, unknown>;

interface JsonlReadResult {
  records: JsonRecord[];
  errors: { line: number; message: string }[];
}

const readJsonl = async (runDir: string, relativePath: string): Promise<JsonlReadResult | undefined> => {
  try {
    const text = await readFile(path.join(runDir, relativePath), "utf8");
    const records: JsonRecord[] = [];
    const errors: { line: number; message: string }[] = [];
    for (const [index, rawLine] of text.split("\n").entries()) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          errors.push({ line: index + 1, message: "expected a JSON object" });
          continue;
        }
        records.push(parsed as JsonRecord);
      } catch (error) {
        errors.push({
          line: index + 1,
          message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    return { records, errors };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const nestedString = (value: unknown, keys: readonly string[]): string | null => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as JsonRecord)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
};

const nestedNumber = (value: unknown, keys: readonly string[]): number | undefined => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as JsonRecord)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
};

const actionValue = (record: JsonRecord): JsonRecord => {
  const result = record.result;
  return typeof result === "object" && result !== null ? result as JsonRecord : record;
};

const actionSequence = (record: JsonRecord): number | undefined => {
  const value = actionValue(record);
  return typeof value.sequence === "number" ? value.sequence : undefined;
};

const attemptValue = (record: JsonRecord): JsonRecord => {
  const attempt = record.attempt;
  return typeof attempt === "object" && attempt !== null ? attempt as JsonRecord : record;
};

const attemptSequence = (record: JsonRecord): number | undefined => {
  const receipt = record.receipt;
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const sequence = (receipt as JsonRecord).sequence;
  return typeof sequence === "number" ? sequence : undefined;
};

const describeActionValue = (value: unknown): string => value === undefined ? "missing" : JSON.stringify(value);

const actionDisagreements = (
  attempts: readonly JsonRecord[],
  results: readonly JsonRecord[]
): string[] => {
  const attemptsBySequence = new Map<number, JsonRecord>();
  const resultsBySequence = new Map<number, JsonRecord>();
  const disagreements: string[] = [];
  for (const attempt of attempts) {
    const sequence = attemptSequence(attempt);
    if (sequence === undefined) {
      disagreements.push("attempt has no matching result (missing sequence)");
      continue;
    }
    attemptsBySequence.set(sequence, attempt);
  }
  for (const result of results) {
    const sequence = actionSequence(result);
    if (sequence === undefined) {
      disagreements.push("result has no matching attempt (missing sequence)");
      continue;
    }
    resultsBySequence.set(sequence, result);
  }
  for (const [sequence, attempt] of attemptsBySequence) {
    const result = resultsBySequence.get(sequence);
    if (result === undefined) {
      disagreements.push(`attempt sequence ${sequence} has no matching result`);
      continue;
    }
    const attemptPayload = attemptValue(attempt);
    const resultPayload = actionValue(result);
    const fields: readonly [string, unknown, unknown][] = [
      ["act_id", attemptPayload.act_id, resultPayload.act_id],
      ["action", attemptPayload.action, resultPayload.action],
      ["actor", attemptPayload.actor, resultPayload.actor],
      ["origin", attemptPayload.origin, resultPayload.origin],
      ["principal_id", attemptPayload.principal_id, resultPayload.principal_id],
      ["target", attemptPayload.target, resultPayload.target],
      ["sequence", attemptSequence(attempt), actionSequence(result)],
      ["apply_tick", nestedNumber(attempt, ["receipt", "apply_tick"]), resultPayload.apply_tick]
    ];
    for (const [field, attemptValueForField, resultValueForField] of fields) {
      if (attemptValueForField !== resultValueForField) {
        disagreements.push(
          `sequence ${sequence} ${field} (attempt ${describeActionValue(attemptValueForField)}, result ${describeActionValue(resultValueForField)})`
        );
      }
    }
  }
  for (const sequence of resultsBySequence.keys()) {
    if (!attemptsBySequence.has(sequence)) disagreements.push(`result sequence ${sequence} has no matching attempt`);
  }
  return disagreements;
};

const decisionIdFor = (record: JsonRecord, events: readonly CausalEvent[], simSecondsPerTick: number): string | null => {
  const value = actionValue(record);
  const attempt = typeof record.attempt === "object" && record.attempt !== null ? record.attempt as JsonRecord : record;
  const direct = nestedString(value, ["decision_id"]) ?? nestedString(attempt, ["decision_id"]);
  if (direct !== null) return direct;
  const sequence = actionSequence(record);
  const principal = nestedString(value, ["principal_id"]) ?? nestedString(attempt, ["principal_id"]);
  const atTick = nestedNumber(attempt, ["at_tick"]);
  const matching = events.find((event) => {
    const payload = event.payload;
    const exactResult = sequence !== undefined && (
      nestedNumber(payload, ["result", "sequence"]) === sequence
      || nestedNumber(payload, ["payload", "result", "sequence"]) === sequence
    );
    const sameDecisionObservation = event.type === "world.perception.observed"
      && (nestedString(payload, ["principal"]) ?? nestedString(payload, ["payload", "principal"])) === principal
      && atTick !== undefined
      && (nestedNumber(payload, ["sim_time"]) ?? nestedNumber(payload, ["payload", "sim_time"])) === atTick * simSecondsPerTick;
    return exactResult || sameDecisionObservation;
  });
  return matching === undefined ? null : (
    nestedString(matching.payload, ["decision_id"])
    ?? nestedString(matching.payload, ["payload", "decision_id"])
    ?? nestedString(matching.payload, ["result", "decision_id"])
    ?? nestedString(matching.payload, ["payload", "result", "decision_id"])
  );
};

const computeActions = (records: readonly JsonRecord[], events: readonly CausalEvent[], simSecondsPerTick: number): WorldEvidence["actions"] => {
  const entries = records.map((record) => {
    const value = actionValue(record);
    const attempt = typeof record.attempt === "object" && record.attempt !== null
      ? record.attempt as JsonRecord
      : record;
    const origin = nestedString(value, ["origin"]) ?? nestedString(attempt, ["origin"]);
    const principal = nestedString(value, ["principal_id"]) ?? nestedString(attempt, ["principal_id"]);
    return {
      action: nestedString(value, ["action"]) ?? nestedString(attempt, ["action"]) ?? "",
      origin,
      principal,
      has_decision_id: decisionIdFor(record, events, simSecondsPerTick) !== null
    };
  });
  return { count: entries.length, entries };
};

const computePossession = (events: readonly CausalEvent[], frameTicks: readonly number[]): WorldEvidence["possession"] => {
  const changes = events.filter((event) => event.type.endsWith(".possession"));
  const ticks = changes.map((event) =>
    nestedNumber(event.payload, ["tick"]) ?? nestedNumber(event.payload, ["payload", "tick"]) ?? nestedNumber(event.payload, ["state", "tick"])
  ).filter((tick): tick is number => tick !== undefined).sort((left, right) => left - right);
  const firstFrame = frameTicks[0];
  const lastFrame = frameTicks.at(-1);
  const covered = changes.length > 0 && ticks.length === changes.length
    && firstFrame !== undefined && lastFrame !== undefined && ticks[0]! <= firstFrame && ticks.at(-1)! <= lastFrame;
  return {
    changes_recorded: changes.length,
    covered,
    ...(ticks[0] === undefined ? {} : { first_change_tick: ticks[0] }),
    ...(ticks.at(-1) === undefined ? {} : { last_change_tick: ticks.at(-1) })
  };
};

const incompleteEvidence = (
  actionResult: JsonlReadResult | undefined,
  perceptionResult: JsonlReadResult | undefined,
  refusalResult: JsonlReadResult | undefined,
  events: readonly CausalEvent[],
  reason: string,
  parseErrors: readonly WorldEvidenceParseError[]
): WorldEvidence => ({
  actions: computeActions(actionResult?.records ?? [], events, 0),
  perception: {
    count: perceptionResult?.records.length ?? 0,
    principals: [...new Set((perceptionResult?.records ?? []).flatMap((record) => typeof record.principal === "string" ? [record.principal] : []))].sort()
  },
  refusals: {
    count: refusalResult?.records.length ?? 0,
    reasons: (refusalResult?.records ?? []).flatMap((record) => typeof record.reason === "string" ? [record.reason] : [])
  },
  possession: computePossession(events, []),
  pace: {
    measured_wall_elapsed_seconds: 0,
    declared_sim_seconds_per_tick: 0,
    target_sim_seconds: 0,
    kept_up: false
  },
  verdict: {
    passed: false,
    status: "incomplete",
    reasons: [reason, ...parseErrors.map((error) => `incomplete record: ${error.relativePath}:${error.line}: ${error.message}`)]
  }
});

export const readWorldEvidence = async (runDir: string, events: readonly CausalEvent[]): Promise<WorldEvidenceReadResult> => {
  const paths = ["raw/action-results.jsonl", "raw/action-attempts.jsonl", "raw/world/perception.jsonl", "raw/world/action-refusals.jsonl", "raw/frames.jsonl"] as const;
  const [actionResult, attemptResult, perceptionResult, refusalResult, frameResult] = await Promise.all([
    readJsonl(runDir, "raw/action-results.jsonl"),
    readJsonl(runDir, "raw/action-attempts.jsonl"),
    readJsonl(runDir, "raw/world/perception.jsonl"),
    readJsonl(runDir, "raw/world/action-refusals.jsonl"),
    readJsonl(runDir, "raw/frames.jsonl")
  ]);
  const readResults = [actionResult, attemptResult, perceptionResult, refusalResult, frameResult];
  const parseErrors = readResults.flatMap((result, index) => (result?.errors ?? []).map((error) => ({ relativePath: paths[index]!, ...error })));
  if (actionResult === undefined && perceptionResult === undefined && refusalResult === undefined && frameResult === undefined) return { parseErrors };
  if (frameResult === undefined) return {
    evidence: incompleteEvidence(actionResult, perceptionResult, refusalResult, events, "frames record is missing", parseErrors),
    parseErrors
  };

  const frameRecords = frameResult.records;
  const header = frameRecords[0];
  const tickRecords = frameRecords.slice(1);
  const dt = typeof header?.sim_seconds_per_tick === "number" ? header.sim_seconds_per_tick : undefined;
  const elapsed = tickRecords.map((record) => record.wall_elapsed_seconds).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const target = dt === undefined ? undefined : tickRecords.reduce((sum, record) => sum + (typeof record.sim_seconds_advanced === "number" ? record.sim_seconds_advanced : dt), 0);
  if (dt === undefined || target === undefined || elapsed.length !== tickRecords.length) return {
    evidence: incompleteEvidence(
      actionResult,
      perceptionResult,
      refusalResult,
      events,
      dt === undefined ? "frames record has no valid simulation rate" : "frames record has an incomplete tick",
      parseErrors
    ),
    parseErrors
  };

  const attempts = attemptResult?.records ?? [];
  const results = actionResult?.records ?? [];
  const disagreementDetails = actionDisagreements(attempts, results);
  const attemptsBySequence = new Map(attempts.map((record) => {
    const sequence = attemptSequence(record);
    return [sequence, record] as const;
  }));
  const actions = computeActions((actionResult?.records ?? []).map((record) => ({
    ...record,
    ...(attemptsBySequence.get(actionSequence(record)) === undefined ? {} : {
      attempt: attemptsBySequence.get(actionSequence(record))?.attempt
    })
  })), events, dt);
  const perception = perceptionResult?.records ?? [];
  const refusals = refusalResult?.records ?? [];
  const reasons: string[] = [];
  const incompleteReasons = parseErrors.map((error) => `incomplete record: ${error.relativePath}:${error.line}: ${error.message}`);
  const nonAgentic = actions.entries.filter((entry) => entry.origin !== "agentic").map((entry) => `${entry.action}: origin ${entry.origin ?? "missing"}`);
  const unnamed = actions.entries.filter((entry) => entry.principal === null).map((entry) => entry.action);
  const unnamedDecisions = actions.entries.filter((entry) => !entry.has_decision_id).map((entry) => entry.action);
  if (disagreementDetails.length > 0) reasons.push(`action attempt/result disagreement: ${disagreementDetails.join(", ")}`);
  if (nonAgentic.length > 0) reasons.push(`non-agentic actions: ${nonAgentic.join(", ")}`);
  if (unnamed.length > 0) reasons.push(`actions without named principal: ${unnamed.join(", ")}`);
  if (unnamedDecisions.length > 0) reasons.push(`actions without decision id: ${unnamedDecisions.join(", ")}`);
  if (perception.length === 0) reasons.push("perception stream is empty");
  const possession = computePossession(events, tickRecords.flatMap((record) => typeof record.tick === "number" ? [record.tick] : []));
  if (possession.changes_recorded === 0) reasons.push("no possession changes recorded");
  else if (!possession.covered) reasons.push("possession changes do not cover the frame run");
  const measured = elapsed.reduce((sum, value) => sum + value, 0);
  const pace = {
    measured_wall_elapsed_seconds: measured,
    declared_sim_seconds_per_tick: dt,
    target_sim_seconds: target,
    kept_up: measured <= target
  };
  if (!pace.kept_up) reasons.push("wall pace exceeded declared simulation time");
  const evidence: WorldEvidence = {
    actions,
    perception: { count: perception.length, principals: [...new Set(perception.flatMap((record) => typeof record.principal === "string" ? [record.principal] : []))].sort() },
    refusals: { count: refusals.length, reasons: refusals.flatMap((record) => typeof record.reason === "string" ? [record.reason] : []) },
    possession,
    pace,
    verdict: {
      passed: reasons.length === 0 && incompleteReasons.length === 0,
      status: incompleteReasons.length > 0 ? "incomplete" : reasons.length > 0 ? "failed" : "passed",
      reasons: [...reasons, ...incompleteReasons]
    }
  };
  return { evidence, parseErrors };
};
