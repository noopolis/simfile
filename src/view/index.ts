import { spawn } from "node:child_process";

import { createViewerServer } from "./server.js";
import { loadRunViewerExtensionPlan } from "./runViewerExtensions.js";

export interface ViewCommandOptions {
  extensionDescriptors: string[];
  ignoreRecordedViewerExtensions: boolean;
  port: number;
  sourcePath: string;
  statePath?: string;
  openBrowser: boolean;
}

export interface ParsedViewCommand {
  options?: ViewCommandOptions;
  error?: string;
  help?: boolean;
}

export const parseViewArguments = (argv: readonly string[]): ParsedViewCommand => {
  const parsed: ViewCommandOptions = {
    extensionDescriptors: [],
    ignoreRecordedViewerExtensions: false,
    port: 4400,
    sourcePath: ".",
    openBrowser: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }

    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        return { error: "Missing value for --port" };
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { error: "Invalid value for --port" };
      }
      parsed.port = port;
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      const port = Number(arg.slice("--port=".length));
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { error: "Invalid value for --port" };
      }
      parsed.port = port;
      continue;
    }

    if (arg === "--no-open") {
      parsed.openBrowser = false;
      continue;
    }

    if (arg === "--ignore-recorded-viewer-extensions") {
      parsed.ignoreRecordedViewerExtensions = true;
      continue;
    }

    if (arg === "--viewer-extension") {
      const value = argv[index + 1];
      if (!value) {
        return { error: "Missing value for --viewer-extension" };
      }
      parsed.extensionDescriptors.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--viewer-extension=")) {
      parsed.extensionDescriptors.push(
        arg.slice("--viewer-extension=".length),
      );
      continue;
    }

    if (arg === "--state") {
      const value = argv[index + 1];
      if (!value) {
        return { error: "Missing value for --state" };
      }
      parsed.statePath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--state=")) {
      parsed.statePath = arg.slice("--state=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      return { error: `Unknown flag ${arg}` };
    }

    if (parsed.sourcePath !== ".") {
      return { error: `Unexpected positional argument ${arg}` };
    }
    parsed.sourcePath = arg;
  }

  return {
    options: {
      ...parsed,
      mode: parsed.statePath ? "live" : "replay",
    } as ViewCommandOptions & { mode: "live" | "replay" },
  };
}

export const runViewCommand = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseViewArguments(argv);

  if (parsed.help) {
    process.stdout.write(viewUsage());
    return 0;
  }

  if (parsed.error || !parsed.options) {
    if (parsed.error) process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(viewUsage());
    return 1;
  }

  let handle;
  try {
    if (parsed.options.ignoreRecordedViewerExtensions) {
      process.stderr.write(
        "WARNING: RECORDED VIEWER EXTENSIONS ARE BEING IGNORED; "
        + "the generic viewer was explicitly requested.\n",
      );
    }
    const extensionPlan = await loadRunViewerExtensionPlan({
      explicitDescriptors: parsed.options.extensionDescriptors,
      ignoreRecorded: parsed.options.ignoreRecordedViewerExtensions,
      runDir: parsed.options.sourcePath,
      trustedRoot: process.cwd(),
    });
    handle = await createViewerServer({
      extensions: extensionPlan.mounts,
      extensionIdentities: extensionPlan.identities,
      reconcileViewerExtensionsAtSeal: extensionPlan.reconcileAtSeal,
      port: parsed.options.port,
      sourcePath: parsed.options.sourcePath,
      statePath: parsed.options.statePath,
      mode: parsed.options.statePath ? "live" : "replay",
      ...(parsed.options.ignoreRecordedViewerExtensions
        ? { recordedViewerExtensions: "ignored" as const }
        : {}),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const modeLabel = parsed.options.statePath ? "live" : "replay";
  process.stdout.write(
    `Simfile viewer running at ${handle.url} (mode: ${modeLabel})\n`
  );
  process.stdout.write(`Press Ctrl+C to stop.\n`);

  if (parsed.options.openBrowser) {
    openBrowser(handle.url);
  }

  await new Promise<never>(() => {});
  return 0;
};

const openBrowser = (url: string): void => {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start \"\""
    : "xdg-open";

  spawn(command, [url], { detached: true, stdio: "ignore", shell: true });
};

const viewUsage = (): string => [
  "Usage:",
  "  simfile view --state <path>",
  "  simfile view <run-record-dir>",
  "  simfile view <run-record-dir> [--ignore-recorded-viewer-extensions]",
  "  simfile view --port 4400 --no-open --state .sim/ [--viewer-extension <descriptor>]",
  "  simfile view --help",
  "",
].join("\n");
