import { parseDurationSeconds } from "../kernel/duration.js";

export interface ConditionVariableNode {
  variable: string;
  above?: number;
  below?: number;
  for?: string;
}

export interface ConditionPhaseNode {
  phase: string;
}

export interface ConditionEventNode {
  event: string;
  target?: string;
  actor?: string;
  scope?: string;
}

export interface ConditionAllNode {
  all: readonly ConditionNode[];
}

export interface ConditionAnyNode {
  any: readonly ConditionNode[];
}

export interface ConditionNotNode {
  not: ConditionNode;
}

export type ConditionNode = ConditionVariableNode | ConditionPhaseNode | ConditionEventNode | ConditionAllNode | ConditionAnyNode | ConditionNotNode;

export interface ConditionEventMatch {
  kind: string;
  actor?: string;
  target?: string;
  scope?: string;
}

export interface RuntimeConditionContext {
  tick: number;
  simTime: number;
  phase?: string;
  variables: Readonly<Record<string, number>>;
  eventsAtTick: readonly ConditionEventMatch[];
}

interface HoldState {
  startTimeByCondition: Map<string, number>;
}

const conditionKey = (node: ConditionVariableNode): string => {
  return `${node.variable}:${node.above ?? ""}:${node.below ?? ""}:${node.for ?? ""}`;
};

const matchesVariableCondition = (
  node: ConditionVariableNode,
  state: RuntimeConditionContext,
  holdState: HoldState
): boolean => {
  const value = state.variables[node.variable];
  const above = node.above ?? -Infinity;
  const below = node.below ?? Infinity;
  const now = Number.isFinite(value) ? value : 0;
  const passesWindow = now > above && now < below;
  if (node.for === undefined) {
    return passesWindow;
  }

  const key = conditionKey(node);
  const required = parseDurationSeconds(node.for);
  if (!passesWindow) {
    holdState.startTimeByCondition.delete(key);
    return false;
  }

  const started = holdState.startTimeByCondition.get(key);
  if (started === undefined) {
    holdState.startTimeByCondition.set(key, state.simTime);
    return required <= 0;
  }

  return state.simTime - started >= required;
};

const matchesEventCondition = (
  node: ConditionEventNode,
  eventsAtTick: readonly ConditionEventMatch[]
): boolean => {
  return eventsAtTick.some((event) => {
    if (event.kind !== node.event) {
      return false;
    }
    if (node.actor !== undefined && node.actor !== event.actor) {
      return false;
    }
    if (node.target !== undefined && node.target !== event.target) {
      return false;
    }
    if (node.scope !== undefined && node.scope !== event.scope) {
      return false;
    }
    return true;
  });
};

const asVariableNode = (node: ConditionNode): node is ConditionVariableNode => {
  return "variable" in node;
};

const asPhaseNode = (node: ConditionNode): node is ConditionPhaseNode => {
  return "phase" in node;
};

const asEventNode = (node: ConditionNode): node is ConditionEventNode => {
  return "event" in node;
};

const asAllNode = (node: ConditionNode): node is ConditionAllNode => {
  return "all" in node;
};

const asAnyNode = (node: ConditionNode): node is ConditionAnyNode => {
  return "any" in node;
};

const asNotNode = (node: ConditionNode): node is ConditionNotNode => {
  return "not" in node;
};

/**
 * Every `variable` id referenced anywhere in a condition tree, deduped, in
 * first-seen order — read straight off the compiled `when:` tree, never
 * invented. The grounding for "this rule/event is about variable X": a
 * caller (`trace-compile.ts`'s `compileRules`) uses this to precompute
 * `RuleRuntime.variableIds`, which `step-tick.ts` then threads onto the
 * rule's own `rule.fired` event and every world-effect event it emits, so
 * the viewer can attribute those events to the variable's own storyline
 * (`src/view/runTimelineRecords.ts`'s `buildWorldRecord`) without this
 * package importing anything view-specific.
 */
export const conditionVariableIds = (node: ConditionNode): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();

  const visit = (current: ConditionNode): void => {
    if (asVariableNode(current)) {
      if (!seen.has(current.variable)) {
        seen.add(current.variable);
        ids.push(current.variable);
      }
      return;
    }
    if (asAllNode(current)) {
      current.all.forEach(visit);
      return;
    }
    if (asAnyNode(current)) {
      current.any.forEach(visit);
      return;
    }
    if (asNotNode(current)) {
      visit(current.not);
    }
  };

  visit(node);
  return ids;
};

export class ConditionEvaluator {
  private readonly holdState: HoldState = { startTimeByCondition: new Map() };

  public evaluate(node: ConditionNode, context: RuntimeConditionContext): boolean {
    if (asVariableNode(node)) {
      return matchesVariableCondition(node, context, this.holdState);
    }

    if (asPhaseNode(node)) {
      return context.phase === node.phase;
    }

    if (asEventNode(node)) {
      return matchesEventCondition(node, context.eventsAtTick);
    }

    if (asAllNode(node)) {
      return node.all.every((child) => this.evaluate(child, context));
    }

    if (asAnyNode(node)) {
      return node.any.some((child) => this.evaluate(child, context));
    }

    if (asNotNode(node)) {
      return !this.evaluate(node.not, context);
    }

    return false;
  }
}
