import { simfileEventKinds, type Simfile } from "./model.js";

type SimfileWhenNode = Simfile["rules"][string]["when"];

const EXPRESSION_IDENTIFIER_PATTERN = /[a-zA-Z_][a-zA-Z0-9_-]*/gu;
const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_-]*)\}/gu;
const RESERVED_EXPRESSION_NAMES = new Set(["abs", "ceil", "clamp", "cos", "e", "exp", "floor", "lerp", "log", "max", "min", "mod", "pi", "pow", "sin", "smoothstep", "sqrt", "step", "t", "tick"]);
const SIMFILE_EVENT_KIND_SET = new Set<string>(simfileEventKinds);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

const validateWhenNode = (
  node: SimfileWhenNode,
  location: string,
  variableIds: ReadonlySet<string>,
  phaseIds: ReadonlySet<string>
): void => {
  if (!isRecord(node)) {
    throw new Error(`${location} must be a condition object`);
  }
  if ("all" in node) {
    if (!Array.isArray(node.all)) throw new Error(`${location}.all must be a list`);
    node.all.forEach((child) => validateWhenNode(child, location, variableIds, phaseIds));
    return;
  }
  if ("any" in node) {
    if (!Array.isArray(node.any)) throw new Error(`${location}.any must be a list`);
    node.any.forEach((child) => validateWhenNode(child, location, variableIds, phaseIds));
    return;
  }
  if ("not" in node) {
    validateWhenNode(node.not, location, variableIds, phaseIds);
    return;
  }
  if ("variable" in node) {
    const variableId = stringValue(node.variable);
    if (variableId === undefined || !variableIds.has(variableId)) {
      throw new Error(`${location} references unknown variable ${String(node.variable)}`);
    }
    return;
  }
  if ("phase" in node) {
    const phaseId = stringValue(node.phase);
    if (phaseId === undefined || !phaseIds.has(phaseId)) {
      throw new Error(`${location} references unknown phase ${String(node.phase)}`);
    }
    return;
  }
  if ("event" in node) {
    const eventKind = stringValue(node.event);
    if (eventKind === undefined || !SIMFILE_EVENT_KIND_SET.has(eventKind)) {
      throw new Error(`${location} references unknown event ${String(node.event)}`);
    }
  }
};

const validatePlaceholders = (
  content: string,
  location: string,
  variableIds: ReadonlySet<string>
): void => {
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    const variableId = match[1];
    if (!variableIds.has(variableId)) {
      throw new Error(`${location} placeholder references unknown variable ${variableId}`);
    }
  }
};

const expressionDependencies = (expression: string): string[] => {
  const dependencies = new Set<string>();
  for (const match of expression.matchAll(EXPRESSION_IDENTIFIER_PATTERN)) {
    const name = match[0];
    const index = match.index ?? 0;
    const previous = expression[index - 1] ?? "";
    if (/[0-9.]/u.test(previous)) {
      continue;
    }
    const suffix = expression.slice(index + name.length).trimStart();
    if (RESERVED_EXPRESSION_NAMES.has(name) || suffix.startsWith("(")) {
      continue;
    }
    dependencies.add(name);
  }
  return [...dependencies];
};

const validateExpressionDependencies = (
  expression: string,
  location: string,
  variableIds: ReadonlySet<string>
): void => {
  expressionDependencies(expression).forEach((dependency) => {
    if (!variableIds.has(dependency)) {
      throw new Error(`${location} references unknown variable ${dependency}`);
    }
  });
};

export const validateSimfileSemantics = (simfile: Simfile): string[] => {
  const warnings: string[] = [];
  const variableIds = new Set(Object.keys(simfile.variables));
  const phaseIds = new Set(Object.keys(simfile.clock.phases));
  const fedVariableIds = new Set(
    Object.entries(simfile.variables)
      .filter(([, variable]) => variable.fed_by !== undefined)
      .map(([variableId]) => variableId)
  );

  for (const [variableId, variable] of Object.entries(simfile.variables)) {
    if (variable.derive) {
      validateExpressionDependencies(variable.derive.eq, `variable ${variableId} derive.eq`, variableIds);
    }
  }

  for (const [generatorId, generator] of Object.entries(simfile.generators)) {
    if (!variableIds.has(generator.variable)) {
      throw new Error(`generator ${generatorId} references unknown variable ${generator.variable}`);
    }
    if (fedVariableIds.has(generator.variable)) {
      throw new Error(`generator ${generatorId} targets fed variable ${generator.variable}; fed variables have exactly one writer (fed_by)`);
    }
    if (generator.when) {
      validateWhenNode(generator.when, `generator ${generatorId} when`, variableIds, phaseIds);
    }
    if (generator.kind === "deterministic") {
      if (generator.delta_eq) {
        validateExpressionDependencies(generator.delta_eq, `generator ${generatorId} delta_eq`, variableIds);
      }
      if (generator.set_eq) {
        validateExpressionDependencies(generator.set_eq, `generator ${generatorId} set_eq`, variableIds);
      }
    }
  }

  for (const [ruleId, rule] of Object.entries(simfile.rules)) {
    validateWhenNode(rule.when, `rule ${ruleId} when`, variableIds, phaseIds);
    for (const action of rule.do) {
      if ((action.action === "variable:set" || action.action === "variable:delta")
        && !variableIds.has(action.variable)) {
        throw new Error(`rule ${ruleId} action ${action.action} references unknown variable ${action.variable}`);
      }
      if ((action.action === "variable:set" || action.action === "variable:delta")
        && fedVariableIds.has(action.variable)) {
        throw new Error(`rule ${ruleId} action ${action.action} targets fed variable ${action.variable}; fed variables have exactly one writer (fed_by)`);
      }
      if ("content" in action) {
        validatePlaceholders(action.content, `rule ${ruleId} action ${action.action}`, variableIds);
      }
    }
  }

  for (const [probeId, probe] of Object.entries(simfile.probes)) {
    validateWhenNode(probe.when, `probe ${probeId} when`, variableIds, phaseIds);
    if (probe.after) {
      validateWhenNode(probe.after, `probe ${probeId} after`, variableIds, phaseIds);
    }
  }

  return warnings;
};
