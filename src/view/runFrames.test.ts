import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  applyRunFrameTrack,
  DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  DYNAMICS_RUN_FRAME_VERSION,
  RUN_FRAME_ROOM_ID,
  readRunFrames,
  readRunFramesFrom,
  runFrameAgents,
  runFrameRoom
} from "./runFrames.js";
import { NO_PLACE_CAPTION } from "./runWorldTrace.js";

const header = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  bounds: { max: [10, 6], min: [-10, -6] },
  sim_seconds_per_tick: 0.05,
  version: DYNAMICS_RUN_FRAMES_HEADER_VERSION,
  ...extra
});

const frame = (tick: number, x: number): string => JSON.stringify({
  objects: [
    { id: "object:a", position: [x, 0], velocity: [1, 0] },
    { id: "object:b", position: [0, x], velocity: [0, 1] }
  ],
  tick,
  version: DYNAMICS_RUN_FRAME_VERSION
});

const timedFrame = (tick: number, wall: number, advanced: number): string => JSON.stringify({
  objects: [], tick, version: DYNAMICS_RUN_FRAME_VERSION,
  wall_elapsed_seconds: wall, sim_seconds_advanced: advanced
});

const runDir = async (text: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-frames-"));
  await mkdir(path.join(dir, "raw"), { recursive: true });
  await writeFile(path.join(dir, "raw", "frames.jsonl"), text, "utf8");
  return dir;
};

const withDir = async (text: string, body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await runDir(text);
  try {
    await body(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("readRunFrames", () => {
  it("reads a complete track into viewer spatial samples", async () => {
    await withDir(`${header()}\n${frame(0, 0)}\n${frame(1, 2)}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(track.bounds, { max: [10, 6], min: [-10, -6] });
      // 0.05 simulated seconds per tick == 50ms, NOT the client's 20ms default.
      assert.equal(track.tickDurationMs, 50);
      assert.equal(track.simSecondsPerTick, 0.05);
      assert.deepEqual(track.timing, []);
      assert.deepEqual(track.samples, [
        {
          objects: [
            { id: "object:a", position: [0, 0], velocity: [1, 0] },
            { id: "object:b", position: [0, 0], velocity: [0, 1] }
          ],
          occupancy: {}, tick: 0, transit: []
        },
        {
          objects: [
            { id: "object:a", position: [2, 0], velocity: [1, 0] },
            { id: "object:b", position: [0, 2], velocity: [0, 1] }
          ],
          occupancy: {}, tick: 1, transit: []
        }
      ]);
    });
  });

  it("preserves generic discontinuity, occupancy, and transit evidence", async () => {
    const richFrame = JSON.stringify({
      discontinuities: ["object:a"],
      objects: [{ id: "object:a", position: [3, 1], velocity: [0, 0] }],
      occupancy: { field: ["object:a"] },
      tick: 3,
      transit: [{ agent: "object:a", from_room: "field", path_id: "restart",
        ticks_remaining: 0, to_room: "field" }],
      version: DYNAMICS_RUN_FRAME_VERSION,
    });
    await withDir(`${header()}\n${richFrame}\n`, async (dir) => {
      assert.deepEqual((await readRunFrames(dir))?.samples, [{
        discontinuities: ["object:a"],
        objects: [{ id: "object:a", position: [3, 1], velocity: [0, 0] }],
        occupancy: { field: ["object:a"] },
        tick: 3,
        transit: [{ agent: "object:a", from_room: "field", path_id: "restart",
          ticks_remaining: 0, to_room: "field" }],
      }]);
    });
  });

  it("keeps timing for complete frames before a torn final line", async () => {
    await withDir(`${header()}
${timedFrame(0, 0.1, 0.05)}
${timedFrame(1, 0.2, 0.05)}
{"version":"${DYNAMICS_RUN_FRAME_VERSION}","tick":2`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(track.timing, [
        { tick: 0, wallElapsedSeconds: 0.1, simSecondsAdvanced: 0.05 },
        { tick: 1, wallElapsedSeconds: 0.2, simSecondsAdvanced: 0.05 },
      ]);
    });
  });

  it("joins sparse timing rows to their sample ticks", async () => {
    await withDir(`${header()}
${timedFrame(0, 0.1, 0.05)}
${frame(1, 2)}
${timedFrame(2, 0.3, 0.05)}
`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(track.samples.map((sample) => sample.tick), [0, 1, 2]);
      assert.deepEqual(track.timing, [
        { tick: 0, wallElapsedSeconds: 0.1, simSecondsAdvanced: 0.05 },
        { tick: 2, wallElapsedSeconds: 0.3, simSecondsAdvanced: 0.05 },
      ]);
    });
  });

  it("returns the complete prefix of a torn final line instead of throwing", async () => {
    // The honest proxy for live: a run still being written ends in a partial
    // line. That is not corruption and must not lose the ticks before it.
    const complete = `${header()}\n${frame(0, 0)}\n${frame(1, 2)}\n${frame(2, 4)}\n`;
    // Every truncation point from "one byte missing" to "the third frame has
    // barely started", so no cut position is special-cased by luck.
    const shortest = `${header()}\n`.length;
    for (let length = complete.length - 1; length >= shortest; length -= 1) {
      await withDir(complete.slice(0, length), async (dir) => {
        const track = await readRunFrames(dir);
        assert.ok(track);
        assert.equal(track.samples.every((sample) => sample.objects !== undefined), true);
        // A prefix of the ticks, in order, never a gap and never a throw.
        assert.deepEqual(track.samples.map((sample) => sample.tick),
          [0, 1, 2].slice(0, track.samples.length));
      });
    }
  });

  it("reports nothing readable while even the header line is still partial", async () => {
    const partial = `${header()}`.slice(0, -3);
    await withDir(partial, async (dir) => {
      assert.equal(await readRunFrames(dir), undefined);
    });
  });

  it("reads a header-only file as a track with no motion, not as an error", async () => {
    await withDir(`${header()}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(track.samples, []);
      assert.deepEqual(runFrameAgents(track), []);
    });
  });

  it("returns undefined when there is no frames file at all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-frames-none-"));
    try {
      assert.equal(await readRunFrames(dir), undefined);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("refuses a file whose first line is not the frames header", async () => {
    for (const first of [frame(0, 0), JSON.stringify({ version: "other.v1" }), "[]"]) {
      await withDir(`${first}\n`, async (dir) => {
        assert.equal(await readRunFrames(dir), undefined);
      });
    }
  });

  it("stops at the first line that is well-formed JSON but not a frame", async () => {
    await withDir(
      `${header()}\n${frame(0, 0)}\n${JSON.stringify({ version: "other.v1" })}\n${frame(2, 4)}\n`,
      async (dir) => {
        const track = await readRunFrames(dir);
        assert.ok(track);
        assert.deepEqual(track.samples.map((sample) => sample.tick), [0]);
      }
    );
  });

  it("rejects frames carrying non-finite or malformed geometry", async () => {
    const bad = [
      { objects: [{ id: "object:a", position: [null, 0], velocity: [0, 0] }], tick: 1 },
      { objects: [{ id: "object:a", position: [0, 0] }], tick: 1 },
      { objects: [{ id: 7, position: [0, 0], velocity: [0, 0] }], tick: 1 },
      { objects: [{ id: "object:a", position: [0, 0, 0], velocity: [0, 0] }], tick: 1 },
      { objects: "nope", tick: 1 },
      { objects: [], tick: 1.5 }
    ];
    for (const entry of bad) {
      const line = JSON.stringify({ ...entry, version: DYNAMICS_RUN_FRAME_VERSION });
      await withDir(`${header()}\n${frame(0, 0)}\n${line}\n`, async (dir) => {
        const track = await readRunFrames(dir);
        assert.ok(track);
        assert.deepEqual(track.samples.map((sample) => sample.tick), [0]);
      });
    }
  });

  it("falls back to 20ms only when the header carries no usable tick duration", async () => {
    for (const dt of [undefined, 0, -1, "fast", Number.NaN]) {
      const raw = JSON.parse(header()) as Record<string, unknown>;
      if (dt === undefined) delete raw.sim_seconds_per_tick;
      else raw.sim_seconds_per_tick = dt;
      await withDir(`${JSON.stringify(raw)}\n`, async (dir) => {
        assert.equal((await readRunFrames(dir))?.tickDurationMs, 20);
      });
    }
  });

  it("omits bounds rather than inventing an extent when the header has none", async () => {
    const raw = JSON.parse(header()) as Record<string, unknown>;
    delete raw.bounds;
    await withDir(`${JSON.stringify(raw)}\n${frame(0, 0)}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.equal(track.bounds, undefined);
      assert.deepEqual(runFrameRoom(track), []);
    });
  });
});

describe("readRunFramesFrom", () => {
  it("keeps its cursor when the file temporarily disappears", async () => {
    const missing = path.join(tmpdir(), "simfile-run-frames-missing", "frames.jsonl");
    const offset = 1234;
    const result = await readRunFramesFrom(missing, offset);
    assert.deepEqual(result, { samples: [], timing: [], nextOffsetBytes: offset });
  });

  it("tails appended chunks without repeating frames or consuming a torn line", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-frames-tail-"));
    const framesPath = path.join(dir, "frames.jsonl");
    try {
      const first = `${header()}\n${frame(0, 0)}\n`;
      await writeFile(framesPath, first, "utf8");
      let offset = 0;
      const seen: number[] = [];
      let result = await readRunFramesFrom(framesPath, offset);
      offset = result.nextOffsetBytes;
      seen.push(...result.samples.map((sample) => sample.tick));

      await writeFile(framesPath, `${first}${frame(1, 1)}\n{"version":"${DYNAMICS_RUN_FRAME_VERSION}","tick":2`, "utf8");
      result = await readRunFramesFrom(framesPath, offset);
      offset = result.nextOffsetBytes;
      seen.push(...result.samples.map((sample) => sample.tick));
      assert.deepEqual(seen, [0, 1]);

      await writeFile(framesPath, `${first}${frame(1, 1)}\n${frame(2, 2)}\n${frame(3, 3)}\n`, "utf8");
      result = await readRunFramesFrom(framesPath, offset);
      seen.push(...result.samples.map((sample) => sample.tick));
      assert.deepEqual(seen, [0, 1, 2, 3]);
      assert.equal(result.nextOffsetBytes, Buffer.byteLength(await readFile(framesPath)));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("runFrameAgents", () => {
  it("emits one sorted agent per distinct object id across the whole track", async () => {
    // Without these the client renders NOTHING: scene nodes come from
    // rooms/agents/signals, and spatial samples only override an existing
    // node's position.
    const late = JSON.stringify({
      objects: [{ id: "object:c", position: [1, 1], velocity: [0, 0] }],
      tick: 2,
      version: DYNAMICS_RUN_FRAME_VERSION
    });
    await withDir(`${header()}\n${frame(0, 0)}\n${late}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(runFrameAgents(track).map((agent) => agent.id),
        ["object:a", "object:b", "object:c"]);
      assert.deepEqual(runFrameAgents(track).map((agent) => agent.scope),
        ["object:a", "object:b", "object:c"]);
    });
  });
});

describe("runFrameRoom", () => {
  it("sizes and centres one floor from the declared bounds", async () => {
    await withDir(`${JSON.stringify({
      bounds: { max: [12, 6], min: [-8, -2] },
      sim_seconds_per_tick: 0.02,
      version: DYNAMICS_RUN_FRAMES_HEADER_VERSION
    })}\n${frame(0, 0)}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      const rooms = runFrameRoom(track);
      assert.equal(rooms.length, 1);
      assert.equal(rooms[0]!.id, RUN_FRAME_ROOM_ID);
      // Full extent (the client draws center ± size/2) and the true midpoint,
      // so every body recorded inside `bounds` lands on the floor.
      assert.deepEqual(rooms[0]!.scale, [20, 8]);
      assert.deepEqual(rooms[0]!.scene, [2, 2, 0]);
      assert.deepEqual(rooms[0]!.members, []);
    });
  });
});

describe("applyRunFrameTrack", () => {
  const base = {
    agents: [{ id: "agent:red", scope: "agent:agent:red" }],
    corridors: [],
    ledger_facts: [],
    presence: [],
    rooms: [{
      id: "room:run:run-room", kind: "room" as const, label: "run-room",
      members: [], scene: [0, 0, 0] as [number, number, number], scope: "room:run:run-room",
      access_hint: NO_PLACE_CAPTION,
    }],
    run_id: "r", run_name: "r", signals: [] as never[], spatial_samples: [],
    version: "viewer.trace.v1" as const
  };

  it("passes a trace through untouched when there is no track", () => {
    assert.equal(applyRunFrameTrack(base, undefined), base);
    assert.equal(applyRunFrameTrack(base, { samples: [], tickDurationMs: 20 }), base);
  });

  it("adds samples, agents, the recorded floor, and the tick duration", async () => {
    await withDir(`${header()}\n${frame(0, 0)}\n${frame(1, 2)}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      const world = applyRunFrameTrack(base, track);
      assert.equal(world.spatial_samples.length, 2);
      assert.deepEqual(world.agents.map((agent) => agent.id),
        ["agent:red", "object:a", "object:b"]);
      // The placeless anchor is replaced by a floor bodies can move across.
      assert.deepEqual(world.rooms.map((room) => room.id), ["room:frames"]);
      assert.equal(world.tick_duration_ms, 50);
      // The pre-existing trace is not mutated.
      assert.deepEqual(base.spatial_samples, []);
      assert.equal(base.agents.length, 1);
    });
  });

  it("keeps the run's own rooms when the track declares no bounds", async () => {
    const raw = JSON.parse(header()) as Record<string, unknown>;
    delete raw.bounds;
    await withDir(`${JSON.stringify(raw)}\n${frame(0, 0)}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      assert.deepEqual(applyRunFrameTrack(base, track).rooms.map((room) => room.id),
        ["room:run:run-room"]);
    });
  });

  it("preserves producer-authored rooms and does not duplicate existing agents", async () => {
    await withDir(`${header()}\n${JSON.stringify({
      objects: [
        { id: "agent:red", position: [1, 0], velocity: [0, 0] },
        { id: "object:new", position: [2, 0], velocity: [0, 0] },
      ],
      tick: 1,
      version: DYNAMICS_RUN_FRAME_VERSION,
    })}\n`, async (dir) => {
      const track = await readRunFrames(dir);
      assert.ok(track);
      const authored = {
        ...base,
        rooms: [{ ...base.rooms[0]!, access_hint: undefined, label: "authored field" }],
      };
      const world = applyRunFrameTrack(authored, track);
      assert.deepEqual(world.rooms.map(({ label }) => label), ["authored field"]);
      assert.deepEqual(world.agents.map(({ id }) => id), ["agent:red", "object:new"]);
    });
  });
});
