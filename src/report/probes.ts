import { parseDurationMs } from "../kernel/duration.js";
import type { LedgerEvent } from "../ledger/markers.js";
import {
  attachVariablesToEventOccurrences,
  buildEventOccurrences,
  buildSampleOccurrences,
  normalizeProbeArtifact,
  type ProbeArtifact,
  type ProbeOccurrence,
  type ProbeSample
} from "./probeArtifact.js";

export interface ProbeEventAtom {
  event: string;
  target?: string;
  actor?: string;
  scope?: string;
}

export interface ProbeVariableAtom {
  variable: string;
  above?: number;
  below?: number;
  for?: string;
}

export interface ProbePhaseAtom {
  phase: string;
}

export interface ProbeAllNode {
  all: readonly ProbeNode[];
}

export interface ProbeAnyNode {
  any: readonly ProbeNode[];
}

export interface ProbeNotNode {
  not: ProbeNode;
}

export type ProbeNode = ProbeEventAtom | ProbeVariableAtom | ProbePhaseAtom | ProbeAllNode | ProbeAnyNode | ProbeNotNode;

export type ProbeExpectation =
  | { at_least: number }
  | { at_most: number }
  | { always: true }
  | { at_end: true };

export interface ProbeDefinition {
  when: ProbeNode;
  expect: ProbeExpectation;
  after?: ProbeWhenCondition;
  within?: string;
}

export type ProbeWhenCondition = ProbeNode;

export type { ProbeArtifact, ProbeSample } from "./probeArtifact.js";

export interface ProbeEvaluationResult {
  probeId: string;
  passed: boolean;
  evidence: string[];
  count: number;
}

type ProbeExpectationMode =
  | { mode: "at_least"; value: number }
  | { mode: "at_most"; value: number }
  | { mode: "always" }
  | { mode: "at_end" };

interface HoldState {
  startTimeByCondition: Map<string, number>;
}

const eventAtomMatch = (event: LedgerEvent, atom: ProbeEventAtom): boolean => {
  if (event.kind !== atom.event) {
    return false;
  }
  if (atom.target !== undefined && atom.target !== event.target) {
    return false;
  }
  if (atom.actor !== undefined && atom.actor !== event.actor) {
    return false;
  }
  if (atom.scope !== undefined && atom.scope !== event.scope) {
    return false;
  }
  return true;
};

const holdKey = (node: ProbeVariableAtom): string => `${node.variable}:${node.above ?? ""}:${node.below ?? ""}:${node.for ?? ""}`;

const matchVariableAtom = (node: ProbeVariableAtom, occurrence: ProbeOccurrence, holdState: HoldState): boolean => {
  const value = occurrence.variables?.[node.variable];
  const above = node.above ?? -Infinity;
  const below = node.below ?? Infinity;
  const passesWindow = value !== undefined && Number.isFinite(value) && value > above && value < below;

  if (node.for === undefined) {
    return passesWindow;
  }

  const key = holdKey(node);
  if (!passesWindow || occurrence.simTime === undefined) {
    holdState.startTimeByCondition.delete(key);
    return false;
  }

  const started = holdState.startTimeByCondition.get(key);
  if (started === undefined) {
    holdState.startTimeByCondition.set(key, occurrence.simTime);
    return parseDurationMs(node.for) <= 0;
  }

  return (occurrence.simTime - started) * 1_000 >= parseDurationMs(node.for);
};

const nodeHasEventAtom = (node: ProbeNode): boolean => {
  if ("event" in node) {
    return true;
  }
  if ("all" in node) {
    return node.all.some(nodeHasEventAtom);
  }
  if ("any" in node) {
    return node.any.some(nodeHasEventAtom);
  }
  if ("not" in node) {
    return nodeHasEventAtom(node.not);
  }
  return false;
};

const matchesNode = (node: ProbeNode, occurrence: ProbeOccurrence, holdState: HoldState): boolean => {
  if ("all" in node) {
    return node.all.every((child) => matchesNode(child, occurrence, holdState));
  }
  if ("any" in node) {
    return node.any.some((child) => matchesNode(child, occurrence, holdState));
  }
  if ("not" in node) {
    return !matchesNode(node.not, occurrence, holdState);
  }
  if ("event" in node) {
    return occurrence.event ? eventAtomMatch(occurrence.event, node) : false;
  }
  if ("phase" in node) {
    return occurrence.phase === node.phase;
  }
  return matchVariableAtom(node, occurrence, holdState);
};

const matchingOccurrences = (
  node: ProbeNode,
  occurrences: readonly ProbeOccurrence[]
): ProbeOccurrence[] => {
  const holdState: HoldState = { startTimeByCondition: new Map() };
  return occurrences.filter((occurrence) => matchesNode(node, occurrence, holdState));
};

const filterWithAfter = (
  matches: readonly ProbeOccurrence[],
  afterMatches: readonly ProbeOccurrence[],
  probe: ProbeDefinition
): ProbeOccurrence[] => {
  if (probe.after === undefined) {
    return [...matches];
  }
  if (probe.within === undefined) {
    throw new Error("within is required when after is set");
  }

  const withinMs = parseDurationMs(probe.within);
  return matches.filter((match) => {
    if (match.simTime === undefined) {
      return false;
    }
    const matchSimTime = match.simTime;
    const matchTimeMs = matchSimTime * 1_000;
    return afterMatches.some((afterMatch) => {
      if (afterMatch.simTime === undefined || afterMatch.simTime >= matchSimTime) {
        return false;
      }
      return matchTimeMs - (afterMatch.simTime * 1_000) <= withinMs;
    });
  });
};

const parseExpectation = (expect: ProbeExpectation): ProbeExpectationMode => {
  if ("at_least" in expect) {
    if (!Number.isInteger(expect.at_least) || expect.at_least < 0) {
      throw new Error("expect.at_least must be a non-negative integer");
    }
    return { mode: "at_least", value: expect.at_least };
  }
  if ("at_most" in expect) {
    if (!Number.isInteger(expect.at_most) || expect.at_most < 0) {
      throw new Error("expect.at_most must be a non-negative integer");
    }
    return { mode: "at_most", value: expect.at_most };
  }
  if ("always" in expect) {
    return { mode: "always" };
  }
  if ("at_end" in expect) {
    return { mode: "at_end" };
  }

  throw new Error("unsupported expect mode");
};

const uniqueEvidence = (occurrences: readonly ProbeOccurrence[]): string[] => {
  const seen = new Set<string>();
  const evidence: string[] = [];
  occurrences.forEach((occurrence) => {
    if (seen.has(occurrence.evidenceId)) {
      return;
    }
    seen.add(occurrence.evidenceId);
    evidence.push(occurrence.evidenceId);
  });
  return evidence;
};

const selectOccurrences = (
  node: ProbeNode,
  eventOccurrences: readonly ProbeOccurrence[],
  sampleOccurrences: readonly ProbeOccurrence[]
): readonly ProbeOccurrence[] => (nodeHasEventAtom(node) ? eventOccurrences : sampleOccurrences);

export const evaluateProbe = (
  probeId: string,
  artifactOrEvents: readonly LedgerEvent[] | ProbeArtifact,
  probe: ProbeDefinition
): ProbeEvaluationResult => {
  const artifact = normalizeProbeArtifact(artifactOrEvents);
  const sampleOccurrences = buildSampleOccurrences(artifact.events, artifact.samples ?? []);
  const eventOccurrences = attachVariablesToEventOccurrences(buildEventOccurrences(artifact.events), sampleOccurrences);

  const baseOccurrences = selectOccurrences(probe.when, eventOccurrences, sampleOccurrences);
  const whenMatches = matchingOccurrences(probe.when, baseOccurrences);
  const afterMatches = probe.after === undefined
    ? []
    : matchingOccurrences(
      probe.after,
      selectOccurrences(probe.after, eventOccurrences, sampleOccurrences)
    );
  const matched = filterWithAfter(whenMatches, afterMatches, probe);

  const count = matched.length;
  const expectation = parseExpectation(probe.expect);
  const evidence = uniqueEvidence(matched);

  let passed = false;
  if (expectation.mode === "at_least") {
    passed = count >= expectation.value;
  } else if (expectation.mode === "at_most") {
    passed = count <= expectation.value;
  } else if (expectation.mode === "always") {
    passed = baseOccurrences.length > 0 && count === baseOccurrences.length;
  } else {
    passed = matched.length > 0 && matched[matched.length - 1]?.evidenceId === baseOccurrences.at(-1)?.evidenceId;
  }

  return {
    probeId,
    passed,
    evidence,
    count
  };
};
