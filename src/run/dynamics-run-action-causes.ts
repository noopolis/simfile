import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { createEventId } from "../ledger/stable.js";

export interface DynamicsRunActionCauseIndex {
  close(): Promise<void>;
  lookup(actionSequence: number): Promise<string | undefined>;
  record(actionSequence: number, ledgerSequence: number): Promise<void>;
}

const ENTRY_BYTES = 8;
const entryPosition = (sequence: number): number => {
  const position = (sequence - 1) * ENTRY_BYTES;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(position)) {
    throw new Error("dynamics action cause sequence is outside the index range");
  }
  return position;
};

const closeAndRemove = async (handle: FileHandle, path: string): Promise<void> => {
  const failures: unknown[] = [];
  try { await handle.sync(); } catch (failure) { failures.push(failure); }
  try { await handle.close(); } catch (failure) { failures.push(failure); }
  try { await rm(path, { force: true }); } catch (failure) { failures.push(failure); }
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to remove dynamics action cause index");
  }
};

/** Fixed-width scratch index keeps historical causal lookup off the heap. */
export const createDynamicsRunActionCauseIndex = async (
  stagingRoot: string,
  runId: string
): Promise<DynamicsRunActionCauseIndex> => {
  const path = join(stagingRoot, ".dynamics-action-causes");
  const handle = await open(path, "wx+");
  let closed = false;
  return {
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeAndRemove(handle, path);
    },
    record: async (actionSequence, ledgerSequence): Promise<void> => {
      if (closed) throw new Error("dynamics action cause index is closed");
      if (!Number.isSafeInteger(ledgerSequence) || ledgerSequence < 1) {
        throw new Error("dynamics ledger cause sequence is outside the index range");
      }
      const value = Buffer.alloc(ENTRY_BYTES);
      value.writeBigUInt64BE(BigInt(ledgerSequence));
      const result = await handle.write(value, 0, ENTRY_BYTES, entryPosition(actionSequence));
      if (result.bytesWritten !== ENTRY_BYTES) {
        throw new Error("dynamics action cause index write was incomplete");
      }
    },
    lookup: async (actionSequence): Promise<string | undefined> => {
      if (closed) throw new Error("dynamics action cause index is closed");
      const value = Buffer.alloc(ENTRY_BYTES);
      const result = await handle.read(value, 0, ENTRY_BYTES, entryPosition(actionSequence));
      if (result.bytesRead !== ENTRY_BYTES) return undefined;
      const ledgerSequence = Number(value.readBigUInt64BE());
      return ledgerSequence === 0 ? undefined : createEventId(runId, ledgerSequence);
    }
  };
};
