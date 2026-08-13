import type { Simfile } from "../schema/model.js";

/** Prevents pre-dynamics runtimes from silently producing an incomplete run. */
export const assertLegacyRuntimeCanExecute = (simfile: Simfile, runtimeName: string): void => {
  if (simfile.dynamics) {
    throw new Error(
      `${runtimeName} cannot execute the declared dynamics module; use a dynamics-aware driver`
    );
  }
};
