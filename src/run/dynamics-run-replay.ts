import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { parseDynamicsActionAttempt } from "../dynamics/validation.js";
import { stableStringify } from "../ledger/stable.js";

export interface DynamicsRunActionReplayInput {
  finalCheckpoint: string;
  firstActionSequence: number;
  initialCheckpoint: string;
  runId: string;
  version: string;
}

interface WriteDynamicsRunActionReplayOptions {
  attemptsHandle: FileHandle;
  input: DynamicsRunActionReplayInput;
  openFile?: typeof open;
  stagingRoot: string;
}

const queuedReplayAttempt = (
  line: string
): { attempt: ReturnType<typeof parseDynamicsActionAttempt>; sequence: number } | undefined => {
  const value = JSON.parse(line) as {
    attempt?: unknown;
    receipt?: { queued?: unknown; sequence?: unknown };
  };
  if (stableStringify(value) !== line || value.receipt?.queued === undefined) {
    throw new Error("raw dynamics action attempt record is not canonical");
  }
  if (value.receipt.queued === false) return undefined;
  if (value.receipt.queued !== true || !Number.isSafeInteger(value.receipt.sequence)) {
    throw new Error("raw dynamics queued action receipt has no safe sequence");
  }
  return {
    attempt: parseDynamicsActionAttempt(value.attempt),
    sequence: value.receipt.sequence as number
  };
};

const closeReplayHandle = async (handle: FileHandle): Promise<unknown[]> => {
  const failures: unknown[] = [];
  try { await handle.sync(); } catch (failure) { failures.push(failure); }
  try { await handle.close(); } catch (failure) { failures.push(failure); }
  return failures;
};

/** Rebuilds the replay vector one durable attempt line at a time. */
export const writeDynamicsRunActionReplay = async (
  options: WriteDynamicsRunActionReplayOptions
): Promise<void> => {
  const input = options.input;
  if (!Number.isSafeInteger(input.firstActionSequence) || input.firstActionSequence < 1) {
    throw new Error("dynamics replay first action sequence is invalid");
  }
  await options.attemptsHandle.sync();
  const openFile = options.openFile ?? open;
  const source = await openFile(join(options.stagingRoot, "raw/action-attempts.jsonl"), "r");
  let target: FileHandle | undefined;
  let primary: unknown;
  try {
    target = await openFile(join(options.stagingRoot, "replay/action-stream.json"), "wx");
    await target.write('{"actions":[');
    let first = true;
    let nextSequence = input.firstActionSequence;
    let position = 0;
    let remainder = "";
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    while (true) {
      const read = await source.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      const lines = (remainder + decoder.write(buffer.subarray(0, read.bytesRead))).split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const queued = queuedReplayAttempt(line);
        if (queued === undefined || queued.sequence < nextSequence) continue;
        if (queued.sequence !== nextSequence) {
          throw new Error("raw dynamics queued action sequences are not contiguous");
        }
        await target.write(`${first ? "" : ","}${stableStringify(queued.attempt)}`);
        first = false;
        nextSequence += 1;
      }
    }
    remainder += decoder.end();
    if (remainder.length !== 0) {
      throw new Error("raw dynamics action attempts ended with a torn record");
    }
    await target.write(
      `],"final_checkpoint":${stableStringify(input.finalCheckpoint)}`
      + `,"initial_checkpoint":${stableStringify(input.initialCheckpoint)}`
      + `,"run_id":${stableStringify(input.runId)}`
      + `,"version":${stableStringify(input.version)}}\n`
    );
  } catch (failure) {
    primary = failure;
  }
  const closeFailures = [
    ...await closeReplayHandle(source),
    ...(target === undefined ? [] : await closeReplayHandle(target))
  ];
  if (primary !== undefined && closeFailures.length > 0) {
    throw new AggregateError(
      [primary, ...closeFailures],
      "dynamics replay stream write and cleanup both failed"
    );
  }
  if (primary !== undefined) throw primary;
  if (closeFailures.length > 0) {
    throw new AggregateError(closeFailures, "failed to close dynamics replay stream");
  }
};
