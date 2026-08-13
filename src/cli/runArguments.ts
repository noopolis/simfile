import type { MoltnetArtifactKind } from "../runtime/trace.js";

export interface ParsedRunOptions {
  readonly actsPath?: string;
  readonly clock?: string;
  readonly local: boolean;
  readonly moltnetArtifact?: MoltnetArtifactKind;
  readonly outDir?: string;
  readonly path: string;
  readonly runId?: string;
  readonly seed?: string;
  readonly spawnfileReport?: string;
  readonly ticks?: number;
  readonly view: boolean;
}

type MutableRunOptions = {
  -readonly [Key in keyof Omit<ParsedRunOptions, "local" | "path" | "view">]?:
    ParsedRunOptions[Key];
} & {
  local?: boolean;
  path?: string;
  view?: boolean;
};

const valueFlags = Object.freeze({
  "--acts": "actsPath",
  "--clock": "clock",
  "--out": "outDir",
  "--run-id": "runId",
  "--seed": "seed",
  "--spawnfile-report": "spawnfileReport",
} as const);

const flagValue = (
  arg: string,
  argv: readonly string[],
  index: number,
  flag: string,
): { readonly consumed: number; readonly value?: string } | undefined => {
  if (arg === flag) {
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    return { consumed: 2, value };
  }
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (value.length === 0) throw new TypeError(`Missing value for ${flag}`);
    return { consumed: 1, value };
  }
  return undefined;
};

const parseTicks = (value: string): number => {
  const ticks = Number(value);
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new TypeError("Invalid value for --ticks");
  }
  return ticks;
};

/** Parses the complete run flag surface without opening lifecycle authority. */
export const parseRunArguments = (argv: readonly string[]): ParsedRunOptions => {
  const options: MutableRunOptions = {};
  for (let index = 0; index < argv.length;) {
    const arg = argv[index]!;
    if (arg === "--local" || arg === "--view") {
      const key = arg === "--local" ? "local" : "view";
      if (options[key]) throw new TypeError(`Duplicate flag ${arg}`);
      options[key] = true;
      index += 1;
      continue;
    }
    const ticks = flagValue(arg, argv, index, "--ticks");
    if (ticks !== undefined) {
      if (options.ticks !== undefined) throw new TypeError("Duplicate flag --ticks");
      options.ticks = parseTicks(ticks.value!);
      index += ticks.consumed;
      continue;
    }
    const artifact = flagValue(arg, argv, index, "--moltnet-artifact");
    if (artifact !== undefined) {
      if (options.moltnetArtifact !== undefined) {
        throw new TypeError("Duplicate flag --moltnet-artifact");
      }
      if (artifact.value !== "delivery" && artifact.value !== "transcript") {
        throw new TypeError("Invalid value for --moltnet-artifact");
      }
      options.moltnetArtifact = artifact.value;
      index += artifact.consumed;
      continue;
    }
    let matched = false;
    for (const [flag, key] of Object.entries(valueFlags) as Array<
      [keyof typeof valueFlags, (typeof valueFlags)[keyof typeof valueFlags]]
    >) {
      const parsed = flagValue(arg, argv, index, flag);
      if (parsed === undefined) continue;
      if (options[key] !== undefined) throw new TypeError(`Duplicate flag ${flag}`);
      options[key] = parsed.value;
      index += parsed.consumed;
      matched = true;
      break;
    }
    if (matched) continue;
    if (arg.startsWith("-")) throw new TypeError(`Unknown flag ${arg}`);
    if (options.path !== undefined) {
      throw new TypeError(`Unexpected positional argument ${arg}`);
    }
    options.path = arg;
    index += 1;
  }
  if (options.path === undefined) throw new TypeError("Missing Simfile path");
  return Object.freeze({ ...options, local: options.local ?? false,
    path: options.path, view: options.view ?? false });
};
