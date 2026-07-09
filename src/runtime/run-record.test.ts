import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseCanonicalLedgerJsonl } from "../ledger/validation.js";
import { parseSimfileSource } from "../schema/parse.js";
import { writeRunRecord } from "./run-record.js";

const sourceText = `
simfile_version: "0.1"
name: run-record-world
clock:
  seed: record-seed
  tick: 1m
variables:
  pressure:
    scope: room:office-floor:case-warroom
    initial: 0.8
    range: 0..1
telemetry:
  snapshot_every: 2
generators:
  ramp:
    kind: deterministic
    variable: pressure
    delta: 0.1
rules:
  deadline:
    when:
      variable: pressure
      above: 0.85
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Rosa Delgado belongs here."
      - action: wake:recommend
        to: room:office-floor:case-warroom
markers:
  tenant_name:
    text:
      - "Rosa Delgado"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
probes:
  deadline_seen:
    when:
      event: wake.recommended
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
`;

const writeFixtureRun = async (outDir: string) => {
  const simfile = parseSimfileSource(sourceText, { path: "Simfile.yaml" }).simfile;
  return writeRunRecord({
    outDir,
    runId: "record-run",
    seed: "record-seed",
    simfile,
    sourcePath: "Simfile.yaml",
    sourceText,
    ticks: 4
  });
};

const readContractArtifacts = async (outDir: string): Promise<Record<string, string>> => {
  const names = ["ledger.jsonl", "manifest.yaml", "report.json", "telemetry.json", "viewer-trace.json"];
  const entries = await Promise.all(names.map(async (name) => [name, await readFile(join(outDir, name), "utf8")] as const));
  return Object.fromEntries(entries);
};

describe("writeRunRecord", () => {
  it("writes byte-identical sealed artifacts for identical inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "simfile-record-"));
    const firstDir = join(dir, "first");
    const secondDir = join(dir, "second");

    await writeFixtureRun(firstDir);
    await writeFixtureRun(secondDir);

    assert.deepEqual(await readContractArtifacts(firstDir), await readContractArtifacts(secondDir));
  });

  it("validates canonical ledger JSONL and honors telemetry cadence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "simfile-record-"));
    await writeFixtureRun(dir);

    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    const events = parseCanonicalLedgerJsonl(ledger, { runId: "record-run" });
    assert.equal(events.some((event) => event.kind === "marker.seen"), true);

    const telemetry = JSON.parse(await readFile(join(dir, "telemetry.json"), "utf8")) as {
      samples: Array<{ tick: number }>;
      snapshot_every?: number;
    };
    assert.equal(telemetry.snapshot_every, 2);
    assert.deepEqual(telemetry.samples.map((sample) => sample.tick), [0, 2, 3]);
  });

  it("optionally emits a Moltnet delivery artifact correlated to ledger event ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "simfile-record-"));
    await writeRunRecord({
      moltnetArtifact: "delivery",
      outDir: dir,
      runId: "record-run",
      seed: "record-seed",
      simfile: parseSimfileSource(sourceText, { path: "Simfile.yaml" }).simfile,
      sourcePath: "Simfile.yaml",
      sourceText,
      ticks: 4
    });

    const manifest = await readFile(join(dir, "manifest.yaml"), "utf8");
    assert.match(manifest, /moltnet: moltnet-delivery\.json/);

    const artifact = JSON.parse(await readFile(join(dir, "moltnet-delivery.json"), "utf8")) as {
      deliveries: Array<{
        event_id: string;
        kind: string;
        marker_ids: string[];
        rule_id?: string;
        text?: string;
      }>;
      version: string;
    };

    assert.equal(artifact.version, "simfile.moltnet.delivery.v1");
    assert.deepEqual(
      artifact.deliveries.map((entry) => entry.kind),
      ["world.message", "wake.recommended"]
    );
    assert.deepEqual(
      artifact.deliveries.find((entry) => entry.kind === "world.message")
        && (({ event_id, kind, marker_ids, rule_id, text }) => ({ event_id, kind, marker_ids, rule_id, text }))(artifact.deliveries.find((entry) => entry.kind === "world.message")!),
      {
        event_id: "record-run:3",
        kind: "world.message",
        marker_ids: ["tenant_name"],
        rule_id: "deadline",
        text: "Rosa Delgado belongs here."
      }
    );
    assert.deepEqual(
      artifact.deliveries.find((entry) => entry.kind === "wake.recommended")
        && (({ event_id, kind, marker_ids, rule_id, text }) => ({ event_id, kind, marker_ids, rule_id, text }))(artifact.deliveries.find((entry) => entry.kind === "wake.recommended")!),
      {
        event_id: "record-run:4",
        kind: "wake.recommended",
        marker_ids: [],
        rule_id: undefined,
        text: "deadline"
      }
    );
  });
});
