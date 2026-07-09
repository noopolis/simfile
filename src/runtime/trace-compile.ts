import { parseRange } from "../kernel/range.js";
import type { Simfile, SimfileGenerator, SimfileRule, SimfileRuleAction, SimfileVariable } from "../schema/model.js";
import { ConditionEvaluator, type ConditionNode } from "./condition.js";
import { compileExpression, type CompiledExpression } from "./expression.js";

interface RangeSpec {
  min: number;
  max: number;
}

interface VariableSpec {
  id: string;
  initial: number;
  range: RangeSpec;
  spec: SimfileVariable;
}

interface DerivedSpec {
  expression: CompiledExpression;
}

export interface GeneratorRuntime {
  id: string;
  target: string;
  range: RangeSpec;
  mode: "set" | "delta" | "stochastic";
  when?: { node: ConditionNode; evaluator: ConditionEvaluator };
  delta?: number;
  deltaExpr?: CompiledExpression;
  setExpr?: CompiledExpression;
  uniform?: [number, number];
}

export interface RuleRuntime {
  id: string;
  spec: SimfileRule;
  when: { node: ConditionNode; evaluator: ConditionEvaluator };
  fireMode: "once" | "per_crossing";
  previousMatch: boolean;
  hasFired: boolean;
}

export interface CompiledTraceRuntime {
  initialState: Record<string, number>;
  ranges: Map<string, RangeSpec>;
  derivedOrder: string[];
  derivedExpressions: Map<string, DerivedSpec>;
  generators: GeneratorRuntime[];
  rules: RuleRuntime[];
}

export const parseVariableSpecs = (
  simfile: Simfile,
): Map<string, VariableSpec> => {
  const variables = new Map<string, VariableSpec>();
  for (const [id, spec] of Object.entries(simfile.variables)) {
    const range = parseRange(spec.range);
    const initial = spec.initial ?? 0;
    const rawInitial = Number.isFinite(initial) ? initial : 0;
    variables.set(id, { id, initial: rawInitial, range, spec });
  }

  return variables;
};

const compileWhen = (node: unknown): { node: ConditionNode; evaluator: ConditionEvaluator } => ({
  node: node as ConditionNode,
  evaluator: new ConditionEvaluator()
});

const compareIds = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compileGenerator = (
  generatorId: string,
  generator: SimfileGenerator,
  ranges: Map<string, RangeSpec>
): GeneratorRuntime => {
  const range = ranges.get(generator.variable);
  if (!range) {
    throw new Error(`generator ${generatorId} references unknown variable ${generator.variable}`);
  }

  if (generator.kind === "stochastic") {
    const [min = 0, max = 0] = generator.uniform;
    return {
      id: generatorId,
      target: generator.variable,
      range,
      mode: "stochastic",
      uniform: [min, max],
      when: generator.when ? compileWhen(generator.when) : undefined
    };
  }

  if (generator.delta !== undefined) {
    return {
      id: generatorId,
      target: generator.variable,
      range,
      mode: "delta",
      delta: generator.delta,
      when: generator.when ? compileWhen(generator.when) : undefined
    };
  }

  if (generator.delta_eq !== undefined) {
    return {
      id: generatorId,
      target: generator.variable,
      range,
      mode: "delta",
      deltaExpr: compileExpression(generator.delta_eq),
      when: generator.when ? compileWhen(generator.when) : undefined
    };
  }

  return {
    id: generatorId,
    target: generator.variable,
    range,
    mode: "set",
    setExpr: compileExpression(generator.set_eq ?? "0"),
    when: generator.when ? compileWhen(generator.when) : undefined
  };
};

export const parseDerivedSpecs = (
  variables: ReadonlyMap<string, VariableSpec>
): { order: string[]; specs: Map<string, DerivedSpec> } => {
  const specs = new Map<string, DerivedSpec>();

  for (const [id, variable] of variables.entries()) {
    if (variable.spec.derive === undefined) {
      continue;
    }
    specs.set(id, { expression: compileExpression(variable.spec.derive.eq) });
  }

  const order: string[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();

  const visit = (variableId: string): void => {
    if (seen.has(variableId)) {
      return;
    }
    if (stack.has(variableId)) {
      throw new Error(`derived variable cycle at ${variableId}`);
    }
    stack.add(variableId);
    const spec = specs.get(variableId);
    if (spec) {
      for (const dependency of spec.expression.dependencies) {
        if (specs.has(dependency)) {
          visit(dependency);
        }
      }
    }
    stack.delete(variableId);
    seen.add(variableId);
    order.push(variableId);
  };

  for (const variableId of specs.keys()) {
    visit(variableId);
  }

  return { order, specs };
};

export const compileGenerators = (
  simfile: Simfile,
  ranges: Map<string, RangeSpec>
): GeneratorRuntime[] => {
  return Object.entries(simfile.generators)
    .sort(([left], [right]) => compareIds(left, right))
    .map(([generatorId, generator]) =>
      compileGenerator(generatorId, generator, ranges)
    );
};

export const compileRules = (simfile: Simfile): RuleRuntime[] => {
  return Object.entries(simfile.rules)
    .sort(([left], [right]) => compareIds(left, right))
    .map(([ruleId, rule]) => ({
      id: ruleId,
      spec: rule,
      when: compileWhen(rule.when),
      fireMode: rule.fire,
      previousMatch: false,
      hasFired: false
    }));
};

export const compileRuntime = (simfile: Simfile): CompiledTraceRuntime => {
  const variables = parseVariableSpecs(simfile);

  const initialState: Record<string, number> = {};
  const ranges = new Map<string, RangeSpec>();
  for (const [id, spec] of variables.entries()) {
    initialState[id] = spec.initial;
    ranges.set(id, spec.range);
  }

  const { order, specs: derivedExpressions } = parseDerivedSpecs(variables);
  return {
    initialState,
    ranges,
    derivedOrder: order,
    derivedExpressions,
    generators: compileGenerators(simfile, ranges),
    rules: compileRules(simfile)
  };
};

export const variableTargetFromActions = (actions: readonly SimfileRuleAction[]): string => {
  for (const action of actions) {
    if ("to" in action) {
      return action.to;
    }
  }
  return "global";
};
