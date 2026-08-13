import type { WorldReadLedger, WorldReadLedgerRecord } from "../world/ledger.js";
import {
  createCanonicalEventEnvelope,
  type LedgerEventEnvelope
} from "../ledger/stable.js";
import { resolveCausalPrincipal } from "../ledger/principal.js";
import type { DynamicsRunArtifactWriter } from "./dynamics-run-artifacts.js";
import { WORLD_RUN_PERCEPTION_VERSION } from "./dynamics-run-contract-versions.js";

interface PerceptionEntry extends WorldReadLedgerRecord {
  readonly version: typeof WORLD_RUN_PERCEPTION_VERSION;
}

const compareEntries = (
  left: WorldReadLedgerRecord,
  right: WorldReadLedgerRecord
): number => left.sequence - right.sequence
  || (left.principal < right.principal ? -1 : left.principal > right.principal ? 1 : 0)
  || (left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0);

const readPerceptions = (
  ledger: WorldReadLedger,
  principals: readonly string[],
  after: Map<string, number>
): WorldReadLedgerRecord[] => {
  const entries: WorldReadLedgerRecord[] = [];
  for (const principal of [...principals].sort()) {
    let cursor = after.get(principal) ?? 0;
    for (;;) {
      const page = ledger.read(principal, {
        after: cursor,
        limit: 100,
        operations: ["observe"]
      });
      entries.push(...page.records);
      if (page.records.length === 0 || page.next_after === cursor) break;
      cursor = page.next_after;
      if (page.records.length < 100) break;
    }
    after.set(principal, cursor);
  }
  return entries.sort(compareEntries);
};

export const drainDynamicsRunPerceptions = async (input: Readonly<{
  appendLedger(event: LedgerEventEnvelope): Promise<void>;
  after: Map<string, number>;
  ledger: WorldReadLedger;
  principals: readonly string[];
  previousStepEventId: string;
  runId: string;
  scope: string;
  seq: number;
  simTime: number;
  writer: DynamicsRunArtifactWriter;
}>): Promise<number> => {
  let seq = input.seq;
  for (const entry of readPerceptions(input.ledger, input.principals, input.after)) {
    const record: PerceptionEntry = Object.freeze({
      ...entry,
      version: WORLD_RUN_PERCEPTION_VERSION
    });
    await input.writer.appendJsonl("raw/world/perception.jsonl", record);
    await input.appendLedger(createCanonicalEventEnvelope({
      runId: input.runId,
      seq: seq++,
      kind: "world.perception.observed",
      simTime: input.simTime,
      provenance: "agentic",
      actor: entry.principal,
      target: input.scope,
      scope: input.scope,
      principalId: resolveCausalPrincipal({
        origin: "agentic",
        principalId: entry.principal
      }),
      causeEventIds: [input.previousStepEventId],
      payload: record
    }));
  }
  return seq;
};
