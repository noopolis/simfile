import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { readRunViewerProjection } from "./runViewerProjection.js";

const PROJECTION_PATH = "presentation/world.json";

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const projection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "viewer.trace.v1",
  run_id: "run-1",
  run_name: "generic projection",
  rooms: [],
  corridors: [],
  agents: [],
  presence: [],
  ledger_facts: [],
  signals: [],
  spatial_samples: [],
  ...overrides,
});

interface FixtureOptions {
  declaration?: unknown;
  listed?: boolean;
  raw?: string;
}

const fixture = async (options: FixtureOptions = {}): Promise<string> => {
  const declaration = Object.hasOwn(options, "declaration")
    ? options.declaration
    : PROJECTION_PATH;
  const listed = options.listed ?? true;
  const raw = options.raw ?? `${JSON.stringify(projection())}\n`;
  const root = await mkdtemp(path.join(tmpdir(), "simfile-viewer-projection-"));
  const bytes = Buffer.from(raw);
  await mkdir(path.join(root, "presentation"));
  await writeFile(path.join(root, PROJECTION_PATH), bytes);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    version: "simfile.run-manifest.v1",
    run_id: "run-1",
    created_at: "2026-08-09T00:00:00.000Z",
    contract_versions: {},
    artifacts: listed
      ? [{ path: PROJECTION_PATH, sha256: hash(bytes) }]
      : [],
    world: declaration === undefined
      ? {}
      : { viewer_projection: declaration },
  }));
  return root;
};

const remove = async (root: string): Promise<void> => {
  await rm(root, { force: true, recursive: true });
};

describe("sealed run viewer projection", () => {
  it("loads the one manifest-listed, hash-matched generic trace", async () => {
    const root = await fixture();
    try {
      assert.deepEqual(await readRunViewerProjection(root), projection());
    } finally {
      await remove(root);
    }
  });

  it("returns undefined when the manifest declares no projection", async () => {
    const root = await fixture({ declaration: undefined });
    try {
      assert.equal(await readRunViewerProjection(root), undefined);
    } finally {
      await remove(root);
    }
  });

  it("fails closed for malformed, escaping, and unlisted declarations", async () => {
    const cases: FixtureOptions[] = [
      { declaration: 7 },
      { declaration: "../world.json" },
      { declaration: "/tmp/world.json" },
      { declaration: "presentation\\world.json" },
      { declaration: "presentation/./world.json" },
      { declaration: "presentation//world.json" },
      { listed: false },
    ];
    for (const options of cases) {
      const root = await fixture(options);
      try {
        await assert.rejects(readRunViewerProjection(root), /viewer_projection/u);
      } finally {
        await remove(root);
      }
    }
  });

  it("rejects changed bytes and a listed symlink escaping the run", async () => {
    const changed = await fixture();
    try {
      await writeFile(path.join(changed, PROJECTION_PATH), "changed\n");
      await assert.rejects(
        readRunViewerProjection(changed),
        /viewer projection integrity failed/u,
      );
    } finally {
      await remove(changed);
    }

    const escaped = await fixture();
    const outside = `${escaped}-outside.json`;
    try {
      await writeFile(outside, `${JSON.stringify(projection())}\n`);
      await rm(path.join(escaped, PROJECTION_PATH));
      await symlink(outside, path.join(escaped, PROJECTION_PATH));
      await assert.rejects(
        readRunViewerProjection(escaped),
        /escapes the run directory/u,
      );
    } finally {
      await remove(escaped);
      await rm(outside, { force: true });
    }
  });

  it("validates JSON, trace version, run correlation, and required arrays", async () => {
    const invalid: string[] = [
      "{not-json\n",
      `${JSON.stringify(projection({ version: "viewer.trace.v2" }))}\n`,
      `${JSON.stringify(projection({ run_id: "another-run" }))}\n`,
      `${JSON.stringify(projection({ run_name: 3 }))}\n`,
      ...[
        "rooms",
        "corridors",
        "agents",
        "presence",
        "ledger_facts",
        "signals",
        "spatial_samples",
      ].map((field) => `${JSON.stringify(projection({ [field]: {} }))}\n`),
    ];
    for (const raw of invalid) {
      const root = await fixture({ raw });
      try {
        await assert.rejects(
          readRunViewerProjection(root),
          /invalid viewer projection/u,
        );
      } finally {
        await remove(root);
      }
    }
  });

  it("rejects non-positive or malformed tick durations", async () => {
    for (const tickDuration of [0, -1, "fast", null]) {
      const root = await fixture({
        raw: `${JSON.stringify(projection({ tick_duration_ms: tickDuration }))}\n`,
      });
      try {
        await assert.rejects(
          readRunViewerProjection(root),
          /tick_duration_ms/u,
        );
      } finally {
        await remove(root);
      }
    }
  });

  it("validates sealed spatial samples as strictly as the live projection", async () => {
    const invalidSamples = [
      [{ tick: -1, occupancy: {}, transit: [] }],
      [{ tick: 1, occupancy: [], transit: [] }],
      [{ tick: 1, occupancy: {}, transit: "moving" }],
      [{ tick: 1, occupancy: {}, transit: [], discontinuities: [7] }],
      [{ tick: 1, occupancy: {}, transit: [],
        objects: [{ id: "ball", position: [0], velocity: [0, 0] }] }],
      [{ tick: 1, occupancy: {}, transit: [{ agent: "ball", from_room: "a",
        path_id: "p", ticks_remaining: -1, to_room: "b" }] }],
      [
        { tick: 1, occupancy: {}, transit: [] },
        { tick: 1, occupancy: {}, transit: [] },
      ],
    ];
    for (const spatial_samples of invalidSamples) {
      const root = await fixture({
        raw: `${JSON.stringify(projection({ spatial_samples }))}\n`,
      });
      try {
        await assert.rejects(readRunViewerProjection(root), /viewer projection/u);
      } finally {
        await remove(root);
      }
    }
  });
});
