import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resolvePackageRoot } from "./package-root.ts";

const root = resolvePackageRoot(import.meta.url);
const sdk = "@modelcontextprotocol/sdk";
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, {
    dependencies?: Record<string, string>;
    version?: string;
    resolved?: string;
    integrity?: string;
  }>;
};

test("SDK manifest and lockfile agree on the declared release", () => {
  const version = manifest.dependencies[sdk];
  assert.equal(lock.packages[""].dependencies?.[sdk], version);
  const locked = lock.packages[`node_modules/${sdk}`];
  assert.equal(locked.version, version);
  assert.equal(locked.resolved, `https://registry.npmjs.org/${sdk}/-/sdk-${version}.tgz`);
  assert.match(locked.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
});

test("installed SDK matches the locked release used for verification", () => {
  const installed = JSON.parse(readFileSync(
    path.join(root, "node_modules", sdk, "package.json"), "utf8",
  )) as { version: string };
  assert.equal(installed.version, lock.packages[`node_modules/${sdk}`].version,
    "Install the locked SDK before verifying the dependency upgrade");
});

test("no locked SDK release falls below the GHSA-22jm-h49p-29qw patch floor", () => {
  const versions = [manifest.dependencies[sdk], ...Object.entries(lock.packages)
    .filter(([location]) => location.endsWith(`node_modules/${sdk}`))
    .map(([, entry]) => entry.version)];
  assert.ok(versions.length >= 2, "SDK must be pinned and locked");
  for (const version of versions) {
    assert.match(version ?? "", /^\d+\.\d+\.\d+$/u, "SDK must use a stable exact release");
    const [major, minor] = version!.split(".").map(Number);
    assert.ok(major > 1 || (major === 1 && minor >= 32),
      `SDK ${version} is below the minimum patched release 1.32.0`);
  }
});
