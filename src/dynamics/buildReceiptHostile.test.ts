import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDynamicsBuildReceipt, type DynamicsBuildReceipt } from "./buildReceipt.js";
import { createBuildTestProject, removeBuildTestPaths, writeBuildFile } from "./buildTestSupport.test-helper.js";
import { createLockFile, createPackageManifest, writeSourceFile } from "./buildReceiptLock.test-helper.js";
import {
  assertNoForbiddenText,
  createPackageAndTypeFixture
} from "./buildReceipt.test-helper.js";
import { sha256 } from "./buildIdentity.js";

type LocaleProcessLocale = "en-US" | "sv-SE";

interface LocaleChildResult {
  readonly childPid: number;
  readonly requestedLocale: LocaleProcessLocale;
  readonly resolvedLocale: string;
  readonly controlOrder: readonly string[];
  readonly localeEnvironment: {
    readonly lang: string | undefined;
    readonly lcAll: string | undefined;
  };
  readonly receipt: DynamicsBuildReceipt;
}

const LOCALE_ENV: Record<LocaleProcessLocale, string> = {
  "en-US": "en_US.UTF-8",
  "sv-SE": "sv_SE.UTF-8"
} as const;

const LOCALE_CONTROL_ORDER: Record<LocaleProcessLocale, readonly string[]> = {
  "en-US": ["ä", "z"],
  "sv-SE": ["z", "ä"]
} as const;

const readStreamText = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const runLocaleReceiptChild = async (projectDirectory: string, locale: LocaleProcessLocale): Promise<LocaleChildResult> => {
  const expectedLocaleEnv = LOCALE_ENV[locale];
  const buildModuleUrl = new URL("./build.js", import.meta.url).href;
  const receiptModuleUrl = new URL("./buildReceipt.js", import.meta.url).href;
  const script = [
    "import path from \"node:path\";",
    `import { prepareDynamicsBuild } from ${JSON.stringify(buildModuleUrl)};`,
    `import { createDynamicsBuildReceipt } from ${JSON.stringify(receiptModuleUrl)};`,
    `const projectDirectory = ${JSON.stringify(projectDirectory)};`,
    "const locale = process.env.SIMFILE_TEST_LOCALE ?? \"en-US\";",
    "const localeEnvironment = {",
    `  \"en-US\": ${JSON.stringify(LOCALE_ENV["en-US"])},`,
    `  \"sv-SE\": ${JSON.stringify(LOCALE_ENV["sv-SE"])}`,
    "};",
    "const requestedLocale = locale.replace(\"_\", \"-\");",
    "const expectedLocale = localeEnvironment[requestedLocale];",
    "if (!expectedLocale) {",
    "  throw new Error(`unsupported locale ${requestedLocale}`);",
    "}",
    "const lang = process.env.LANG;",
    "const lcAll = process.env.LC_ALL;",
    "if (lang !== expectedLocale || lcAll !== expectedLocale) {",
    "  throw new Error(`child locale mismatch: LANG=${lang} LC_ALL=${lcAll} expected=${expectedLocale}`);",
    "}",
    "const collator = new Intl.Collator(undefined, { usage: \"sort\", sensitivity: \"variant\" });",
    "const controlOrder = [\"ä\", \"z\"];",
    "controlOrder.sort(collator.compare);",
    "const resolvedLocale = collator.resolvedOptions().locale;",
    "if (!resolvedLocale.toLowerCase().startsWith(requestedLocale.toLowerCase())) {",
    "  throw new Error(`child locale mismatch: ${requestedLocale} -> ${resolvedLocale}`);",
    "}",
    "const prepared = await prepareDynamicsBuild(path.join(projectDirectory, \"Simfile\"), \"./provider.ts\");",
    "const receipt = await createDynamicsBuildReceipt(path.join(projectDirectory, \"Simfile\"), prepared);",
    "process.stdout.write(JSON.stringify({",
    "  childPid: process.pid,",
    "  requestedLocale,",
    "  resolvedLocale,",
    "  controlOrder,",
    "  localeEnvironment: { lang, lcAll },",
    "  receipt",
    "}));"
  ].join("\n");

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      LANG: expectedLocaleEnv,
      LC_ALL: expectedLocaleEnv,
      SIMFILE_TEST_LOCALE: locale
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const [stdout, stderr] = await Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  if (exitCode !== 0) throw new Error(`locale receipt child failed (${exitCode}): ${stderr}`);
  try {
    return JSON.parse(stdout) as LocaleChildResult;
  } catch {
    throw new Error(`locale child returned invalid JSON: ${stdout}`);
  }
};

const createLocaleReceiptFixture = async (parent: string) => {
  const project = await createBuildTestProject(parent);
  const projectManifest = path.join(project.directory, "package.json");
  await writeFile(projectManifest, JSON.stringify({
    name: "fixture-project",
    version: "1.0.0",
    type: "module",
    dependencies: { "fixture-pkg": "1.2.3" }
  }));

  const packageDirectory = path.join(project.directory, "node_modules", "fixture-pkg");
  await createPackageManifest(packageDirectory, "fixture-pkg", "1.2.3", {
    type: "module",
    main: "./index.ts"
  });
  await writeSourceFile(path.join(packageDirectory, "index.ts"), "export const fixture = 11;\n");

  await createLockFile(project.directory, "fixture-project", "1.0.0", [
    { path: "node_modules/fixture-pkg", version: "1.2.3" }
  ], {
    dependencies: {
      "fixture-pkg": "1.2.3"
    }
  });

  await writeBuildFile(project, "systems/ä.ts", "export const a = 11;\n");
  await writeBuildFile(project, "systems/z.ts", "export const z = 26;\n");
  await writeBuildFile(project, "provider.ts", [
    "import type { DynamicsSession } from \"simfile/dynamics\";",
    "import { fixture } from \"fixture-pkg\";",
    "import { a } from \"./systems/ä.ts\";",
    "import { z } from \"./systems/z.ts\";",
    "",
    "const consumeSession = (_session: DynamicsSession): number => 1;",
    "export const value = consumeSession(null as unknown as DynamicsSession) + fixture + a + z;"
  ].join("\n") + "\n");

  return project;
};

const scrubLockEvidence = (receipt: DynamicsBuildReceipt): unknown => ({
  ...receipt.payload,
  build_tools: receipt.payload.build_tools.map((entry) => ({
    ...entry,
    lock_sha256: "LOCK_SHA256"
  })),
  deduped_locks: receipt.payload.deduped_locks.map((entry) => ({
    ...entry,
    lock_sha256: "LOCK_SHA256"
  })).sort((left, right) => Buffer.compare(Buffer.from(JSON.stringify(left)), Buffer.from(JSON.stringify(right)))),
  portable_claims: receipt.payload.portable_claims.map((entry) => ({
    ...entry,
    lock_sha256: "LOCK_SHA256",
    tool_identities: entry.tool_identities.map((tool) => ({
      ...tool,
      lock_sha256: "LOCK_SHA256"
    }))
  }))
});

const assertReceiptCanonical = (receipt: DynamicsBuildReceipt): void => {
  const receiptText = Buffer.from(receipt.receiptBytes).toString("utf8");
  assert.equal(receipt.receiptBytes[receipt.receiptBytes.length - 1], 10);
  assert.equal(receiptText.endsWith("\n"), true);
  assert.equal(receipt.receiptSha256, sha256(Uint8Array.from(receipt.receiptBytes)));
};

test("actual receipt cross-root and cross-locale stability", async () => {
  const tmpRoot = await realpath(os.tmpdir());
  const roots: string[] = [];
  try {
    const rootOne = await mkdtemp(path.join(tmpRoot, "simfile-b13-locale-one-"));
    roots.push(rootOne);
    const rootTwo = await mkdtemp(path.join(tmpRoot, "simfile-b13-locale-two-"));
    roots.push(rootTwo);
    const fixtureOne = await createLocaleReceiptFixture(rootOne);
    const fixtureTwo = await createLocaleReceiptFixture(rootTwo);
    const children = await Promise.all([
      runLocaleReceiptChild(fixtureOne.directory, "en-US"),
      runLocaleReceiptChild(fixtureOne.directory, "sv-SE"),
      runLocaleReceiptChild(fixtureTwo.directory, "en-US"),
      runLocaleReceiptChild(fixtureTwo.directory, "sv-SE")
    ]);

    assert.equal(new Set(children.map((entry) => entry.childPid)).size, 4);

    const expectedPairs: ReadonlyArray<[LocaleProcessLocale, readonly string[]]> = [
      ["en-US", LOCALE_CONTROL_ORDER["en-US"]],
      ["sv-SE", LOCALE_CONTROL_ORDER["sv-SE"]],
      ["en-US", LOCALE_CONTROL_ORDER["en-US"]],
      ["sv-SE", LOCALE_CONTROL_ORDER["sv-SE"]]
    ];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const [expectedLocale, expectedOrder] = expectedPairs[index]!;
      assert.equal(child.requestedLocale, expectedLocale);
      assert.deepEqual(child.controlOrder, expectedOrder);
      assert.equal(child.localeEnvironment.lang, LOCALE_ENV[expectedLocale]);
      assert.equal(child.localeEnvironment.lcAll, LOCALE_ENV[expectedLocale]);
      assert.equal(child.resolvedLocale.toLowerCase().startsWith(expectedLocale.toLowerCase()), true);
    }

    assert.notDeepEqual(children[0]!.controlOrder, children[1]!.controlOrder);
    assert.notDeepEqual(children[2]!.controlOrder, children[3]!.controlOrder);

    const rootOneReal = await realpath(fixtureOne.directory);
    const rootTwoReal = await realpath(fixtureTwo.directory);
    const forbiddenRoots = [
      fixtureOne.directory,
      fixtureTwo.directory,
      rootOne,
      rootTwo,
      rootOneReal,
      rootTwoReal,
      tmpRoot,
      await realpath(fixtureOne.directory),
      await realpath(fixtureTwo.directory)
    ];

    const baseline = children[0]!.receipt;
    assertReceiptCanonical(baseline);

    const baselinePayloadText = JSON.stringify(baseline.payload);
    const baselineReceiptText = Buffer.from(baseline.receiptBytes).toString("utf8");
    assertNoForbiddenText(baselinePayloadText, forbiddenRoots);
    assertNoForbiddenText(baselineReceiptText, forbiddenRoots);

    for (const child of children) {
      const payloadText = JSON.stringify(child.receipt.payload);
      const receiptText = Buffer.from(child.receipt.receiptBytes).toString("utf8");
      assert.deepEqual(baseline.payload, child.receipt.payload);
      assert.deepEqual(baseline.receiptBytes, child.receipt.receiptBytes);
      assert.equal(baseline.receiptSha256, child.receipt.receiptSha256);
      assertReceiptCanonical(child.receipt);
      assertNoForbiddenText(payloadText, forbiddenRoots);
      assertNoForbiddenText(receiptText, forbiddenRoots);
    }
  } finally {
    await removeBuildTestPaths(...roots);
  }
});

test("fresh authority/post-prepare failure matrix", async () => {
  const fixtureA = await createPackageAndTypeFixture();
  try {
    const manifestPath = path.join(fixtureA.projectRoot, "node_modules", "fixture-pkg", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      version: "1.2.4"
    }));
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixtureA.absoluteSimfilePath, fixtureA.prepared),
      /missing package lock evidence|claim mismatch|source hash mismatch|mismatch|manifest/i
    );
  } finally {
    await removeBuildTestPaths(fixtureA.projectRoot);
  }

  const fixtureB = await createPackageAndTypeFixture();
  try {
    await rm(path.join(fixtureB.projectRoot, "package-lock.json"), { force: true });
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixtureB.absoluteSimfilePath, fixtureB.prepared),
      /partial project authority/i
    );
  } finally {
    await removeBuildTestPaths(fixtureB.projectRoot);
  }
});

test("receipt-level ambiguity propagation", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const wrapper = path.join(fixture.projectRoot, "node_modules", "wrapper", "node_modules", "fixture-pkg");
    await mkdir(wrapper, { recursive: true });
    await createPackageManifest(wrapper, "fixture-pkg", "1.2.3", {
      type: "module",
      main: "./index.ts"
    });
    await writeSourceFile(path.join(wrapper, "index.ts"), "export const fixture = 11;\n");

    const rawLock = await readFile(path.join(fixture.projectRoot, "package-lock.json"), "utf8");
    const lock = JSON.parse(rawLock) as { packages?: Record<string, Record<string, unknown>> };
    if (!lock.packages || typeof lock.packages !== "object") {
      throw new Error("invalid lock package table");
    }

    lock.packages["node_modules/wrapper/node_modules/fixture-pkg"] = {
      name: "fixture-pkg",
      version: "1.2.3"
    };

    await writeFile(path.join(fixture.projectRoot, "package-lock.json"), JSON.stringify(lock));
    await assert.rejects(
      () => createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared),
      /ambiguous package lock evidence/i
    );
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});

test("portable omission of hostile lock metadata with deterministic evidence deltas", async () => {
  const fixture = await createPackageAndTypeFixture();
  try {
    const baseline = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);

    const hostileUrl = "https://ci-user:secret@registry.example.test/fixture-pkg-1.2.3.tgz?token=fixture&secret=1#sha256";
    const rawLock = await readFile(path.join(fixture.projectRoot, "package-lock.json"), "utf8");
    const lock = JSON.parse(rawLock) as { packages: Record<string, Record<string, unknown>> };
    if (!lock.packages[""] || !lock.packages["node_modules/fixture-pkg"]) {
      throw new Error("missing lock entries");
    }

    lock.packages[""] = {
      ...lock.packages[""],
      resolved: "https://registry.example.test?token=project#secret",
      registry: "registry.example.test",
      integrity: "sha512-hostile-root",
      control: "control\u0007character"
    };
    lock.packages["node_modules/fixture-pkg"] = {
      ...lock.packages["node_modules/fixture-pkg"],
      resolved: hostileUrl,
      registry: "registry.example.test",
      integrity: "sha512-hostile-pkg",
      token: "token-secret",
      secret: "secret-token"
    };
    await writeFile(path.join(fixture.projectRoot, "package-lock.json"), JSON.stringify(lock));

    const hostile = await createDynamicsBuildReceipt(fixture.absoluteSimfilePath, fixture.prepared);

    assertReceiptCanonical(baseline);
    assertReceiptCanonical(hostile);

    const hostilePayloadText = JSON.stringify(hostile.payload);
    const hostileReceiptText = Buffer.from(hostile.receiptBytes).toString("utf8");
    const baselinePayloadText = JSON.stringify(baseline.payload);
    const baselineReceiptText = Buffer.from(baseline.receiptBytes).toString("utf8");
    const baselineRoots = [
      fixture.projectRoot,
      fixture.authority.absoluteProjectRoot,
      fixture.authority.absoluteToolchainRoot,
      fixture.authority.toolchainAuthority.absoluteLockPath,
      fixture.authority.projectAuthority.absoluteLockPath ?? "",
      fixture.authority.absoluteToolchainRoot
    ];
    assertNoForbiddenText(hostilePayloadText, baselineRoots);
    assertNoForbiddenText(baselineReceiptText, baselineRoots);
    assertNoForbiddenText(hostileReceiptText, baselineRoots);
    assert.equal(hostilePayloadText.includes("https://"), false);
    assert.equal(hostilePayloadText.includes("registry.example.test"), false);
    assert.equal(hostilePayloadText.includes("token"), false);
    assert.equal(hostilePayloadText.includes("secret"), false);
    assert.equal(hostilePayloadText.includes("?"), false);
    assert.equal(hostilePayloadText.includes("#"), false);
    assert.equal(hostileReceiptText.includes("?"), false);
    assert.equal(hostileReceiptText.includes("#"), false);
    assert.equal(hostileReceiptText.includes("https://"), false);
    assert.equal(hostileReceiptText.includes("token"), false);
    assert.equal(hostileReceiptText.includes("secret"), false);
    assertNoForbiddenText(baselinePayloadText, baselineRoots);

    assert.equal(baseline.receiptSha256 !== hostile.receiptSha256, true);
    assert.deepEqual(scrubLockEvidence(baseline), scrubLockEvidence(hostile));
    assert.notDeepEqual(baseline.payload.deduped_locks, hostile.payload.deduped_locks);
    assert.notDeepEqual(baseline.payload.portable_claims, hostile.payload.portable_claims);
    assert.deepEqual(baseline.payload.source_graph, hostile.payload.source_graph);
    assert.deepEqual(baseline.payload.build_config_sha256, hostile.payload.build_config_sha256);
    assert.deepEqual(baseline.payload.artifact_sha256, hostile.payload.artifact_sha256);
    assert.deepEqual(baseline.payload.artifact_path, hostile.payload.artifact_path);
  } finally {
    await removeBuildTestPaths(fixture.projectRoot);
  }
});
