import { resolve } from "node:path";

import { isObserveRunDir } from "./runDetect.js";
import { findInProgressDynamicsRun } from "./runFollowLocator.js";
import type { ViewerServerConfig } from "./server.js";

export interface RunLiveBundle {
  readonly stagingDir: string;
}

export const loadRunLiveBundle = async (
  config: ViewerServerConfig,
): Promise<RunLiveBundle | null> => {
  if (config.mode !== "replay" || config.statePath) return null;
  const runDir = resolve(config.sourcePath);
  if (await isObserveRunDir(runDir)) return null;
  const stagingDir = await findInProgressDynamicsRun(runDir);
  return stagingDir === undefined ? null : { stagingDir };
};
