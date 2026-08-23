import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  currentBootstrapOperation,
  journalBootstrapOperationIntent,
  journalBootstrapOperationObservation,
} from "../compose/bootstrapOperationJournal.js";
import type { ComposedJournalSession } from "../compose/journalSession.js";
import {
  parseSpawnfileCredentialProvisioningReceipt,
  runSpawnfileProvisionCredentials,
  type SpawnfileCredentialProvisioningReceipt,
} from "./bootstrapCli.js";
import type { BootstrapSpawnfileCliContext } from "./process.js";

const sha256 = async (file: string): Promise<`sha256:${string}`> =>
  `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;

const verifyFiles = async (receipt: SpawnfileCredentialProvisioningReceipt,
  envFile: string, bindingsFile: string): Promise<void> => {
  if (receipt.env_file_digest !== await sha256(envFile)
    || receipt.world_bindings_digest !== await sha256(bindingsFile)) {
    throw new TypeError("Spawnfile credential output identity changed");
  }
};

export const provisionJournaledCredentials = async (input: Readonly<{
  context: BootstrapSpawnfileCliContext;
  env_file: string;
  journal_session: ComposedJournalSession;
  request: Readonly<Record<string, unknown>>;
  resolved_grants_file: string;
  signal?: AbortSignal;
  world_bindings_file: string;
}>): Promise<SpawnfileCredentialProvisioningReceipt> => {
  let operation = currentBootstrapOperation(
    input.journal_session.current(), "provision_credentials",
  );
  if (operation?.state === "completed") {
    const receipt = parseSpawnfileCredentialProvisioningReceipt(operation.receipt);
    await verifyFiles(receipt, input.env_file, input.world_bindings_file);
    return receipt;
  }
  if (operation !== undefined) {
    if (operation.state !== "ambiguous") {
      await input.journal_session.replace(input.journal_session.current(),
        journalBootstrapOperationObservation(input.journal_session.current(),
          operation.operation_id, "ambiguous"));
    }
    throw new TypeError(
      "Spawnfile credential provisioning outcome is ambiguous; retained resources require operator reconciliation",
    );
  }
  const current = input.journal_session.current();
  await input.journal_session.replace(current, journalBootstrapOperationIntent(
    current, "provision_credentials", input.request,
  ));
  operation = currentBootstrapOperation(
    input.journal_session.current(), "provision_credentials",
  )!;
  try {
    const receipt = await runSpawnfileProvisionCredentials(input.context, {
      env_file: input.env_file,
      request: input.request,
      resolved_grants_file: input.resolved_grants_file,
      signal: input.signal,
      world_bindings_file: input.world_bindings_file,
    });
    await verifyFiles(receipt, input.env_file, input.world_bindings_file);
    const latest = input.journal_session.current();
    await input.journal_session.replace(latest, journalBootstrapOperationObservation(
      latest, operation.operation_id, "completed", receipt,
    ));
    return receipt;
  } catch (error) {
    const latest = input.journal_session.current();
    const pending = currentBootstrapOperation(latest, "provision_credentials");
    if (pending !== undefined && pending.state !== "completed") {
      await input.journal_session.replace(latest, journalBootstrapOperationObservation(
        latest, pending.operation_id, "ambiguous",
      ));
    }
    throw error;
  }
};
