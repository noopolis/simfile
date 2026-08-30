import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseObserveReport } from "./report.js";
import { aggregateUsage, collectUsage, parseUsageLedgerLine } from "./usageLedger.js";

const line = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: "noopolis.daimon.turn-usage.v1",
  agent: "cogsworth",
  wake: "wake-1",
  engine: "grok",
  at: "2026-08-29T12:00:00.000Z",
  input: 100,
  output: 20,
  cache_read: 5,
  cache_write: 0,
  total: 125,
  calls: 1,
  notional_usd: 0.25,
  complete: true,
  ...overrides
});

/** Writes a sealed export tree. `null` omits that generation entirely. */
const makeRunDir = async (generations: { current?: string | null; rotated?: string | null }): Promise<string> => {
  const runDir = await mkdtemp(path.join(tmpdir(), "simfile-usage-ledger-"));
  const entries: [string, string | null | undefined][] = [
    ["usage.jsonl", generations.current],
    ["usage.jsonl.1", generations.rotated]
  ];
  if (entries.some(([, content]) => typeof content === "string")) {
    await mkdir(path.join(runDir, "raw", "daimon"), { recursive: true });
  }
  for (const [name, content] of entries) {
    if (typeof content === "string") {
      await writeFile(path.join(runDir, "raw", "daimon", name), content, "utf8");
    }
  }
  return runDir;
};

describe("parseUsageLedgerLine", () => {
  it("accepts a well-formed record and rejects malformed ones rather than coercing", () => {
    assert.equal(parseUsageLedgerLine(line())?.agent, "cogsworth");
    for (const [reason, bad] of [
      ["blank", "   "],
      ["not json", "{not json"],
      ["wrong version", line({ v: "noopolis.daimon.turn-usage.v2" })],
      ["empty agent", line({ agent: "" })],
      ["unparseable date", line({ at: "not-a-date" })],
      ["non-boolean complete", line({ complete: "yes" })],
      ["negative total", line({ total: -1 })],
      ["non-numeric total", line({ total: "125" })],
      ["unknown key", JSON.stringify({ ...JSON.parse(line()) as object, surprise: 1 })]
    ] as const) {
      assert.equal(parseUsageLedgerLine(bad), null, reason);
    }
  });

  it("skips a torn final line the way a crash mid-append leaves one", async () => {
    const runDir = await makeRunDir({ current: `${line()}\n${line({ wake: "w2" }).slice(0, 40)}` });
    const usage = await collectUsage(runDir);
    assert.equal(usage?.by_agent[0]?.turns, 1);
  });
});

describe("collectUsage", () => {
  /**
   * ROTATION: `usage.jsonl.1` is OLDER. Sums are order-independent, so the
   * observable that actually pins the order is engine attribution — an agent's
   * engine comes from its earliest record, so an agent that switched engines
   * mid-run reports the one it started on. Reversing the generations produces a
   * plausible-looking wrong answer, which is the whole hazard.
   */
  it("reads the rotated generation before the current one", async () => {
    const runDir = await makeRunDir({
      current: `${line({ engine: "agy", notional_usd: 0, wake: "newer" })}\n`,
      rotated: `${line({ engine: "grok", wake: "older" })}\n`
    });

    const usage = await collectUsage(runDir);

    assert.equal(usage?.by_agent.length, 1);
    assert.equal(usage?.by_agent[0]?.turns, 2);
    assert.equal(usage?.by_agent[0]?.engine, "grok");
    assert.deepEqual(usage?.by_engine.map((entry) => entry.engine), ["agy", "grok"]);
  });

  it("splits totals across several agents and engines", async () => {
    const runDir = await makeRunDir({
      current: [
        line({ agent: "cogsworth", engine: "grok", total: 100 }),
        line({ agent: "foreman", engine: "agy", notional_usd: 0, total: 40 }),
        line({ agent: "foreman", engine: "agy", notional_usd: 0, total: 60, wake: "w2" })
      ].join("\n") + "\n"
    });

    const usage = await collectUsage(runDir);

    assert.deepEqual(usage?.by_agent.map((entry) => [entry.agent, entry.turns, entry.tokens]),
      [["cogsworth", 1, 100], ["foreman", 2, 100]]);
    assert.deepEqual(usage?.by_engine.map((entry) => [entry.engine, entry.turns, entry.tokens]),
      [["agy", 2, 100], ["grok", 1, 100]]);
  });

  /**
   * ABSENT IS NOT ZERO. A codex-only organization is never provisioned the
   * ledger volume, and an export may simply not carry one. `undefined` lets the
   * caller omit the report field entirely rather than publish a confident zero —
   * the same absence-preserving convention `world_grants` uses.
   */
  it("reports an export with no ledger as absent, not as an empty observation", async () => {
    assert.equal(await collectUsage(await makeRunDir({})), undefined);
  });

  it("reports a present but unusable ledger as an observed empty, distinct from absent", async () => {
    const usage = await collectUsage(await makeRunDir({ current: "" }));
    assert.notEqual(usage, undefined);
    assert.deepEqual(usage?.by_agent, []);
    assert.deepEqual(usage?.by_engine, []);
  });
});

describe("aggregateUsage lower-bound qualification", () => {
  /**
   * The ledger's decoders label an all-zero usage block UNKNOWN, not free.
   * That caveat has to survive the hop into Simfile's report, or the report
   * launders it into an exact-looking number.
   */
  it("counts decoder-flagged turns as unknown rather than dropping them", () => {
    const record = (overrides: Record<string, unknown> = {}) => {
      const parsed = parseUsageLedgerLine(line(overrides));
      assert.notEqual(parsed, null);
      return parsed!;
    };
    const usage = aggregateUsage([record({ complete: false }), record({ wake: "w2" })]);
    assert.equal(usage.by_agent[0]?.turns, 2);
    assert.equal(usage.by_agent[0]?.unknown_turns, 1);
    assert.equal(usage.unknown_turns, 1);
  });

  it("is representable in simfile.observe.v1 only as a lower bound", () => {
    const base = {
      version: "simfile.observe.v1",
      run_id: "run-1",
      contract_versions: {},
      participants: [],
      agent_turns: { count: 0, sequence: [] },
      chains: { complete: 0, incomplete: [] },
      memory: [],
      failures: [],
      usage: [{ agent: "cogsworth", engine: "grok", turns: 1, tokens: 125, notional_usd: 0.25, unknown_turns: 0 }],
      usage_summary: { lower_bound: true, unknown_turns: 0, by_engine: [{ engine: "grok", turns: 1, tokens: 125, notional_usd: 0.25 }] }
    };
    assert.equal(parseObserveReport(base).usage_summary?.lower_bound, true);
    // A report claiming these counts are exact is not representable.
    assert.throws(
      () => parseObserveReport({ ...base, usage_summary: { ...base.usage_summary, lower_bound: false } }),
      /invalid simfile\.observe\.v1/u
    );
    // Absence stays valid and distinct from an empty observation.
    const { usage: _usage, usage_summary: _summary, ...absent } = base;
    assert.equal(parseObserveReport(absent).usage, undefined);
  });
});
