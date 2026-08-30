import path from "node:path";

import type { Simfile } from "../schema/index.js";
import type { ParsedRunOptions } from "./runArguments.js";

export type SimfileRunRoute = Readonly<
  | { kind: "composed"; linked_spawnfile_path: string }
  | { kind: "local"; linked_spawnfile_path?: string }
>;

const composedForbidden = Object.freeze([
  ["actsPath", "--acts"],
  ["clock", "--clock"],
  ["moltnetArtifact", "--moltnet-artifact"],
  ["spawnfileReport", "--spawnfile-report"],
] as const);

/** Selects linked composition solely from the resolved authored Spawnfile link. */
export const resolveSimfileRunRoute = (input: Readonly<{
  options: ParsedRunOptions;
  simfile: Simfile;
  simfilePath: string;
}>): SimfileRunRoute => {
  const reference = input.simfile.spawnfile;
  const linked = reference === undefined ? undefined
    : path.resolve(path.dirname(path.resolve(input.simfilePath)), reference);
  if (linked !== undefined && !input.options.local) {
    if (input.options.ticks !== undefined) {
      throw new TypeError("Linked composed runs reject --ticks; use --local --ticks for diagnostics");
    }
    for (const [key, flag] of composedForbidden) {
      if (input.options[key] !== undefined) {
        throw new TypeError(`Linked composed runs reject ${flag}`);
      }
    }
    return Object.freeze({ kind: "composed", linked_spawnfile_path: linked });
  }
  if (input.options.ticks === undefined) {
    throw new TypeError("Local runs require --ticks");
  }
  if (input.options.targetContext !== undefined) {
    throw new TypeError("Local runs reject --context");
  }
  if (input.options.composedMode !== undefined) {
    throw new TypeError("Local runs reject --mode");
  }
  if (input.options.view) {
    throw new TypeError("Local runs reject --view");
  }
  return Object.freeze({ kind: "local", ...(linked === undefined
    ? {} : { linked_spawnfile_path: linked }) });
};
