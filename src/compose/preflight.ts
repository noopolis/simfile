import type { DynamicsRunActionSourceDeclaration } from "../dynamics/runActionSource.js";
import type { Simfile } from "../schema/model.js";
import {
  runDurableComposedRun,
  type ComposedRunOutcome,
  type DurableComposedRunInput,
} from "./recovery.js";

export interface ComposedDecisionInputPreflight {
  readonly action_source?: DynamicsRunActionSourceDeclaration;
  readonly acts_path?: string;
  readonly simfile: Simfile;
}

export interface PreflightedComposedRunInput extends DurableComposedRunInput {
  readonly decision_inputs: ComposedDecisionInputPreflight;
}

const scriptedConfigKeys = ["scripted-controller", "scripted_controller"] as const;

/** Rejects local/scripted decision inputs before any composed lifecycle authority is opened. */
export const assertComposedDecisionInputs = (
  input: ComposedDecisionInputPreflight,
): void => {
  if (input.action_source !== undefined) {
    throw new TypeError("composed mode rejects dynamics run action sources");
  }
  const config = input.simfile.dynamics?.config;
  if (config !== undefined && scriptedConfigKeys.some((key) => Object.hasOwn(config, key))) {
    throw new TypeError("composed mode rejects scripted-controller config");
  }
  if (input.acts_path !== undefined) {
    throw new TypeError("composed mode rejects --acts input");
  }
};

/** Public new-run seam: preflight is synchronous and precedes journal or owner mutation. */
export const runPreflightedComposedRun = async (
  input: PreflightedComposedRunInput,
): Promise<ComposedRunOutcome> => {
  assertComposedDecisionInputs(input.decision_inputs);
  const { decision_inputs: _decisionInputs, ...durable } = input;
  return runDurableComposedRun(durable);
};
