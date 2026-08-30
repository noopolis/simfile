import type { ComposedExecution } from "../compose/execution.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import type { ComposedRunPorts } from "../compose/run.js";
import type { ComposedTargetProvider } from "./composedTargetProvider.js";
import { createProductionCleanupPort } from "./productionCleanupPorts.js";
import {
  createProductionOrganizationFinalizationPort,
  createProductionSupervisionPort,
  createProductionWorldFinalizationPort,
} from "./productionFinalizationPorts.js";
import { createProductionOrganizationPorts } from "./productionOrganizationPorts.js";
import { createProductionTargetDriver } from "./productionTarget.js";
import { createProductionTopologyPort } from "./productionTopologyPorts.js";
import {
  createProductionPreparationPort,
  createProductionWorldPort,
} from "./productionWorldPorts.js";

/** Creates production ports using only pinned public Spawnfile commands. */
export const createProductionComposedRunPorts = (input: Readonly<{
  execution: ComposedExecution;
  journal_session: ComposedJournalSession;
  target_provider?: ComposedTargetProvider;
}>): ComposedRunPorts => {
  const driver = createProductionTargetDriver(input);
  return {
    cleanup: createProductionCleanupPort(input.execution, driver),
    organization: createProductionOrganizationPorts(input.execution, driver),
    organization_finalization: createProductionOrganizationFinalizationPort(
      input.execution, driver,
    ),
    preparation: createProductionPreparationPort(input, driver),
    supervision: createProductionSupervisionPort(input.execution, driver),
    topology: createProductionTopologyPort(input.execution, driver),
    world: createProductionWorldPort(input.execution, driver),
    world_finalization: createProductionWorldFinalizationPort(input.execution, driver),
  };
};
