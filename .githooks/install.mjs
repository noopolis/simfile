import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: root,
  encoding: "utf8",
});

if (probe.status !== 0) {
  console.error("Simfile hooks: not a git repository; skipping hook installation.");
  process.exit(0);
}

// `prepare` also runs for git/folder/link installs and for `npm pack`/publish. Only
// configure hooks when this package IS the checkout, never when it is a dependency
// nested inside someone else's repository.
const toplevel = path.resolve(probe.stdout.trim());
if (toplevel !== path.resolve(root)) {
  console.error(`Simfile hooks: ${root} is not the git toplevel (${toplevel}); skipping hook installation.`);
  process.exit(0);
}

const install = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(install.status ?? 1);
