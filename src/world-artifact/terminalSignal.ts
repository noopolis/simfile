import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson } from "../dynamics/buildIdentity.js";

export const COMPOSED_WORLD_TERMINAL_SIGNAL_VERSION =
  "simfile.composed-world-terminal-signal.v1" as const;
export const COMPOSED_WORLD_TERMINAL_ARTIFACT = Object.freeze({
  id: "composed_terminal",
  max_bytes: 131_072,
  path: "/tmp/spawnfile-public/composed-terminal.json",
});

export const composedWorldTerminalSignalSchema = z.object({
  outcome_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  reason: z.enum(["completed", "interrupted"]),
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  terminal_tick: z.number().int().min(1).max(1_000_000_000),
  version: z.literal(COMPOSED_WORLD_TERMINAL_SIGNAL_VERSION),
}).strict();

export type ComposedWorldTerminalSignal = z.infer<
  typeof composedWorldTerminalSignalSchema
>;

export const parseComposedWorldTerminalSignal = (
  raw: unknown,
): ComposedWorldTerminalSignal => Object.freeze(
  composedWorldTerminalSignalSchema.parse(raw),
);

export const createComposedWorldTerminalSignal = (
  fields: Omit<ComposedWorldTerminalSignal, "version">,
): ComposedWorldTerminalSignal => parseComposedWorldTerminalSignal({
  ...fields,
  version: COMPOSED_WORLD_TERMINAL_SIGNAL_VERSION,
});

export const serializeComposedWorldTerminalSignal = (
  signal: ComposedWorldTerminalSignal,
): Uint8Array => new TextEncoder().encode(
  `${canonicalJson(parseComposedWorldTerminalSignal(signal))}\n`,
);

/** Atomically publishes the one fixed public artifact watched by composition. */
export const publishComposedWorldTerminalSignal = async (
  signal: ComposedWorldTerminalSignal,
): Promise<void> => {
  const directory = path.dirname(COMPOSED_WORLD_TERMINAL_ARTIFACT.path);
  const temporary = path.join(
    directory,
    `.composed-terminal-${process.pid}-${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, serializeComposedWorldTerminalSignal(signal), {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporary, COMPOSED_WORLD_TERMINAL_ARTIFACT.path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
};
