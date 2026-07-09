import { readFile } from "node:fs/promises";

import type {
  Simfile,
  SimfileProbe,
  SimfileRule,
  SimfileRuleAction,
  SimfileVariable
} from "./model.js";

export interface BindingDiagnostic {
  level: "error" | "warn";
  message: string;
}

export interface SpawnfileReportNode {
  id?: unknown;
  active_environments?: unknown;
}

export interface SpawnfileReport {
  nodes?: unknown;
}

interface ScopeIndex {
  agents: Set<string>;
  rooms: Set<string>;
  teams: Set<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const addIfDefined = (target: Set<string>, value: unknown): void => {
  if (typeof value === "string" && value.trim()) {
    target.add(value);
  }
};

const parseRoomScope = (value: string): string | undefined => {
  if (!value.startsWith("room:")) {
    return undefined;
  }

  const rest = value.slice("room:".length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex < 0 || separatorIndex === rest.length - 1) {
    return undefined;
  }
  return `room:${rest.slice(0, separatorIndex)}:${rest.slice(separatorIndex + 1)}`;
};

const parseAgentScope = (value: string): string | undefined => {
  if (!value.startsWith("agent:")) {
    return undefined;
  }
  const agentId = value.slice("agent:".length);
  return agentId ? `agent:${agentId}` : undefined;
};

const parseTeamScope = (value: string): string | undefined => {
  if (!value.startsWith("team:")) {
    return undefined;
  }
  const teamId = value.slice("team:".length);
  return teamId ? `team:${teamId}` : undefined;
};

const createEmptyScopeIndex = (): ScopeIndex => ({
  agents: new Set(),
  rooms: new Set(),
  teams: new Set()
});

const addTeamAndAgentScopes = (index: ScopeIndex, node: SpawnfileReportNode): void => {
  if (typeof node.id !== "string") {
    return;
  }

  const [kind, id] = node.id.split(":");
  if (kind === "agent") {
    addIfDefined(index.agents, id);
  }
  if (kind === "team") {
    addIfDefined(index.teams, id);
  }
};

const collectRoomScopes = (index: ScopeIndex, activeEnvironments: unknown): void => {
  if (!isRecord(activeEnvironments)) {
    return;
  }

  const moltnet = activeEnvironments.moltnet;
  if (!isRecord(moltnet)) {
    return;
  }

  for (const [networkId, networkBinding] of Object.entries(moltnet)) {
    if (!isRecord(networkBinding) || typeof networkId !== "string" || !networkId.trim()) {
      continue;
    }
    const rooms = networkBinding.rooms;
    if (!isRecord(rooms)) {
      continue;
    }

    for (const roomId of Object.keys(rooms)) {
      if (!roomId.trim()) {
        continue;
      }
      index.rooms.add(`room:${networkId}:${roomId}`);
    }
  }
};

export const createReportScopeIndex = (report: SpawnfileReport): ScopeIndex => {
  const index = createEmptyScopeIndex();
  if (!isRecord(report) || !Array.isArray(report.nodes)) {
    return index;
  }

  for (const nodeValue of report.nodes) {
    if (!isRecord(nodeValue)) {
      continue;
    }

    const node: SpawnfileReportNode = nodeValue;
    addTeamAndAgentScopes(index, node);
    collectRoomScopes(index, node.active_environments);
  }
  return index;
};

const addMissingAgentDiagnostic = (
  agentScope: string,
  location: string,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if (!index.agents.has(agentScope.slice("agent:".length))) {
    diagnostics.push({
      level: "error",
      message: `${location} references unknown agent ${agentScope}`
    });
  }
};

const addMissingTeamDiagnostic = (
  teamScope: string,
  location: string,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if (!index.teams.has(teamScope.slice("team:".length))) {
    diagnostics.push({
      level: "error",
      message: `${location} references unknown team ${teamScope}`
    });
  }
};

const addMissingRoomDiagnostic = (
  roomScope: string,
  location: string,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if (!index.rooms.has(roomScope)) {
    diagnostics.push({
      level: "error",
      message: `${location} references unknown room ${roomScope}`
    });
  }
};

const addDiagnosticsForScope = (
  scope: string,
  location: string,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  const room = parseRoomScope(scope);
  if (room) {
    addMissingRoomDiagnostic(room, location, index, diagnostics);
    return;
  }

  const agent = parseAgentScope(scope);
  if (agent) {
    addMissingAgentDiagnostic(agent, location, index, diagnostics);
    return;
  }

  const team = parseTeamScope(scope);
  if (team) {
    addMissingTeamDiagnostic(team, location, index, diagnostics);
    return;
  }
};

const isEventNode = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && "event" in value;

const validateConditionScopes = (
  location: string,
  value: unknown,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if (!isRecord(value)) {
    return;
  }

  if ("all" in value) {
    const children = value.all;
    if (!Array.isArray(children)) {
      return;
    }
    children.forEach((child) => {
      validateConditionScopes(location, child, index, diagnostics);
    });
    return;
  }

  if ("any" in value) {
    const children = value.any;
    if (!Array.isArray(children)) {
      return;
    }
    children.forEach((child) => {
      validateConditionScopes(location, child, index, diagnostics);
    });
    return;
  }

  if ("not" in value) {
    validateConditionScopes(location, value.not, index, diagnostics);
    return;
  }

  if (isEventNode(value)) {
    if (typeof value.target === "string") {
      addDiagnosticsForScope(value.target, `${location} event target`, index, diagnostics);
    }
    if (typeof value.actor === "string") {
      addDiagnosticsForScope(value.actor, `${location} event actor`, index, diagnostics);
    }
    if (typeof value.scope === "string" && value.scope !== "global") {
      addDiagnosticsForScope(value.scope, `${location} event scope`, index, diagnostics);
    }
  }
};

const validateVariableScopes = (
  variableId: string,
  variable: SimfileVariable,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if (variable.scope !== "global") {
    addDiagnosticsForScope(variable.scope, `variable "${variableId}" scope`, index, diagnostics);
  }
};

const validateRuleAction = (
  ruleId: string,
  action: SimfileRuleAction,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  if ("to" in action) {
    addDiagnosticsForScope(action.to, `rule "${ruleId}" action ${action.action} target`, index, diagnostics);
  }
};

const validateMarkerScopes = (
  markerId: string,
  markerScopes: readonly string[] | undefined,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  for (const scope of markerScopes ?? []) {
    if (scope !== "global") {
      addDiagnosticsForScope(scope, `marker "${markerId}" scope`, index, diagnostics);
    }
  }
};

const validateRule = (
  ruleId: string,
  rule: SimfileRule,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  validateConditionScopes(`rule "${ruleId}"`, rule.when, index, diagnostics);
  rule.do.forEach((action) => {
    validateRuleAction(ruleId, action, index, diagnostics);
  });
};

const validateProbe = (
  probeId: string,
  probe: SimfileProbe,
  index: ScopeIndex,
  diagnostics: BindingDiagnostic[]
): void => {
  validateConditionScopes(`probe "${probeId}"`, probe.when, index, diagnostics);
  if (probe.after) {
    validateConditionScopes(`probe "${probeId}" after`, probe.after, index, diagnostics);
  }
};

export const createBindingDiagnostics = (simfile: Simfile, report: SpawnfileReport | null): BindingDiagnostic[] => {
  const diagnostics: BindingDiagnostic[] = [];
  if (!report) {
    return diagnostics;
  }

  const index = createReportScopeIndex(report);
  for (const [variableId, variable] of Object.entries(simfile.variables)) {
    validateVariableScopes(variableId, variable, index, diagnostics);
  }
  for (const [markerId, marker] of Object.entries(simfile.markers)) {
    validateMarkerScopes(markerId, marker.scopes, index, diagnostics);
  }
  for (const [ruleId, rule] of Object.entries(simfile.rules)) {
    validateRule(ruleId, rule, index, diagnostics);
  }
  for (const [probeId, probe] of Object.entries(simfile.probes)) {
    validateProbe(probeId, probe, index, diagnostics);
  }

  return diagnostics;
};

export const parseSpawnfileReportJson = (reportJson: string): SpawnfileReport => {
  let report: unknown;
  try {
    report = JSON.parse(reportJson);
  } catch (error: unknown) {
    throw new Error(
      `Invalid Spawnfile report JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(report) && !Array.isArray(report)) {
    throw new Error("Spawnfile report must be a JSON object");
  }
  return report as SpawnfileReport;
};

export const loadSpawnfileReport = async (pathOrJson: string): Promise<SpawnfileReport> => {
  try {
    return parseSpawnfileReportJson(pathOrJson);
  } catch (parseError: unknown) {
    const reportText = await readFile(pathOrJson, "utf8");
    try {
      return parseSpawnfileReportJson(reportText);
    } catch (fileError: unknown) {
      if (parseError instanceof Error) {
        throw parseError;
      }
      throw fileError;
    }
  }
};
