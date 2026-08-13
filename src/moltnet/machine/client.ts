import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { decodeMoltnetMachineTerminal, encodeMoltnetMachineRequest } from "./protocol.js";
import {
  MOLTNET_MACHINE_MAX_ACTIVE_REQUESTS,
  MOLTNET_MACHINE_MAX_LINE_BYTES,
  MoltnetMachineError,
  type MoltnetMachineRequest,
  type MoltnetMachineTerminal
} from "./types.js";

export interface MoltnetMachineClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnChild?: (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => MachineChild;
}

type MachineChild = ChildProcessByStdio<Writable, Readable, null>;

interface PendingRequest {
  readonly operation: MoltnetMachineRequest["operation"];
  readonly reject: (reason: Error) => void;
  readonly resolve: (value: MoltnetMachineTerminal) => void;
  readonly detachAbort: () => void;
  canceled: boolean;
  settled: boolean;
}

interface QueuedWrite {
  readonly line: string;
}

export interface MoltnetMachineClient {
  request(request: MoltnetMachineRequest, signal?: AbortSignal): Promise<MoltnetMachineTerminal>;
  close(): Promise<void>;
}

const childSpawner = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }): MachineChild =>
  spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "ignore"] });

export const createMoltnetMachineClient = (options: MoltnetMachineClientOptions): MoltnetMachineClient => {
  const child = (options.spawnChild ?? childSpawner)(options.command, options.args ?? ["machine"], { env: options.env });
  const pending = new Map<string, PendingRequest>();
  const cancelCorrelations = new Set<string>();
  const writes: QueuedWrite[] = [];
  const maxQueuedWrites = MOLTNET_MACHINE_MAX_ACTIVE_REQUESTS * 2;
  const maxQueuedBytes = maxQueuedWrites * (MOLTNET_MACHINE_MAX_LINE_BYTES + 1);
  let closed = false;
  let eofPending = false;
  let eofReason: Error | undefined;
  let eofDeadline: NodeJS.Timeout | undefined;
  let sequence = 0;
  let writeBlocked = false;
  let queuedBytes = 0;
  let finishEof = (): void => {};
  const failWriter = (): void => fail(new MoltnetMachineError("machine write failed"));
  const flushWrites = (): void => {
    if (closed || writeBlocked) return;
    while (writes.length > 0) {
      const frame = writes.shift()!;
      queuedBytes -= Buffer.byteLength(frame.line, "utf8");
      try {
        if (!child.stdin.write(frame.line, (error) => { if (error) failWriter(); })) {
          writeBlocked = true;
          return;
        }
      } catch { failWriter(); return; }
    }
    finishEof();
  };
  const enqueueWrite = (line: string): boolean => {
    const bytes = Buffer.byteLength(line, "utf8");
    if (closed || writes.length >= maxQueuedWrites || queuedBytes + bytes > maxQueuedBytes) return false;
    writes.push({ line }); queuedBytes += bytes; flushWrites();
    return !closed;
  };
  const fail = (reason: Error, graceful = false): void => {
    if (closed) return;
    closed = true;
    if (eofDeadline) clearTimeout(eofDeadline);
    for (const request of pending.values()) {
      request.detachAbort();
      if (!request.settled) request.reject(reason);
    }
    pending.clear();
    writes.length = 0;
    queuedBytes = 0;
    cancelCorrelations.clear();
    if (graceful) {
      child.stdin.end();
      const forceKill = setTimeout(() => child.kill(), 1_000);
      forceKill.unref();
      return;
    }
    child.stdin.destroy(); child.kill();
  };
  finishEof = () => {
    if (!eofReason || writeBlocked || writes.length > 0) return;
    const reason = eofReason;
    eofReason = undefined;
    fail(reason, true);
  };
  const cancel = (target: string): void => {
    const pendingRequest = pending.get(target);
    if (!pendingRequest || pendingRequest.canceled || closed) return;
    pendingRequest.canceled = true;
    const correlation = `cancel_${++sequence}_${target}`.slice(0, 128);
    try {
      const line = `${encodeMoltnetMachineRequest({ version: "moltnet.machine.v1", correlation_id: correlation, operation: "cancel", cancel: { target_correlation_id: target } })}\n`;
      if (enqueueWrite(line)) cancelCorrelations.add(correlation);
      else failWriter();
    } catch { failWriter(); }
  };
  let stdout = Buffer.alloc(0);
  const consumeLine = (line: string): void => {
    try {
      const response = decodeMoltnetMachineTerminal(line); const request = pending.get(response.correlation_id);
      if (cancelCorrelations.delete(response.correlation_id)) return;
      if (!request || request.operation !== response.operation) throw new MoltnetMachineError("unexpected machine response");
      pending.delete(response.correlation_id); request.detachAbort();
      if (!request.settled) request.resolve(response);
    } catch (error) { fail(error instanceof Error ? error : new MoltnetMachineError("invalid machine response")); }
  };
  child.stdin.on("drain", () => { writeBlocked = false; flushWrites(); });
  child.stdin.on("error", failWriter);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > MOLTNET_MACHINE_MAX_LINE_BYTES && !stdout.includes(0x0a)) return fail(new MoltnetMachineError("machine response exceeds line limit"));
    for (;;) {
      const end = stdout.indexOf(0x0a); if (end < 0) break;
      const line = stdout.subarray(0, end); stdout = stdout.subarray(end + 1);
      if (line.length > MOLTNET_MACHINE_MAX_LINE_BYTES) return fail(new MoltnetMachineError("machine response exceeds line limit"));
      try {
        consumeLine(new TextDecoder("utf-8", { fatal: true }).decode(line).replace(/\r$/u, ""));
      } catch { fail(new MoltnetMachineError("invalid machine response encoding")); return; }
    }
    if (stdout.length > MOLTNET_MACHINE_MAX_LINE_BYTES) fail(new MoltnetMachineError("machine response exceeds line limit"));
  });
  child.stdout.on("end", () => {
    if (closed || eofPending) return;
    eofPending = true;
    for (const id of pending.keys()) cancel(id);
    if (closed) return;
    eofReason = new MoltnetMachineError("machine EOF");
    eofDeadline = setTimeout(() => {
      const reason = eofReason;
      eofReason = undefined;
      if (reason) fail(reason);
    }, 1_000);
    eofDeadline.unref();
    finishEof();
  });
  child.on("error", () => fail(new MoltnetMachineError("machine subprocess failure")));
  child.on("exit", () => { if (!eofPending) fail(new MoltnetMachineError("machine subprocess exited")); });

  return {
    request(request, signal) {
      if (closed || eofPending) return Promise.reject(new MoltnetMachineError("machine client is closed"));
      if (pending.has(request.correlation_id) || pending.size >= MOLTNET_MACHINE_MAX_ACTIVE_REQUESTS) return Promise.reject(new MoltnetMachineError("machine request capacity or duplicate"));
      return new Promise<MoltnetMachineTerminal>((resolve, reject) => {
        let abort = (): void => {};
        const item: PendingRequest = {
          operation: request.operation, resolve, reject, canceled: false, settled: false,
          detachAbort: () => signal?.removeEventListener("abort", abort),
        };
        pending.set(request.correlation_id, item);
        abort = () => {
          if (item.settled) return;
          item.settled = true; cancel(request.correlation_id);
          reject(new MoltnetMachineError("machine request aborted"));
        };
        if (signal?.aborted) {
          pending.delete(request.correlation_id);
          item.settled = true;
          reject(new MoltnetMachineError("machine request aborted"));
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const line = `${encodeMoltnetMachineRequest(request)}\n`;
          if (!enqueueWrite(line)) throw new MoltnetMachineError("machine write queue capacity");
        } catch (error) {
          pending.delete(request.correlation_id); item.detachAbort();
          reject(error instanceof Error ? error : new MoltnetMachineError("machine write failed"));
        }
      });
    },
    async close() {
      for (const id of pending.keys()) cancel(id);
      fail(new MoltnetMachineError("machine client closed"), true);
    }
  };
};
