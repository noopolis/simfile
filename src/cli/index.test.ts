import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCli } from "./index.js";

const captureStdout = async <T>(operation: () => Promise<T>): Promise<{ output: string; result: T }> => {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await operation();
    return { output: chunks.join(""), result };
  } finally {
    process.stdout.write = original;
  }
};

describe("runCli", () => {
  it("validates a Simfile path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-cli-"));
    const file = path.join(dir, "Simfile.yaml");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-world
clock:
  seed: cli-test
  tick: 1m
  phases:
    day: "08:00"
`, "utf8");

    const code = await runCli(["validate", file]);
    assert.equal(code, 0);
  });

  it("validates with JSON output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-cli-json-"));
    const file = path.join(dir, "Simfile.yaml");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-world-json
clock:
  seed: cli-test
  tick: 1m
  phases:
    day: "08:00"
`, "utf8");

    const { output, result } = await captureStdout(async () => runCli(["validate", "--json", file]));
    assert.equal(result, 0);
    const payload = JSON.parse(output) as { ok: boolean; diagnostics: Array<{ level: string; message: string }>; path: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.path, file);
    assert.equal(payload.diagnostics.length, 0);
  });

  it("validates against Spawnfile report scope bindings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-cli-bindings-"));
    const file = path.join(dir, "Simfile.yaml");
    const report = path.join(dir, "spawnfile-report.json");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-bound
clock:
  seed: bound
  tick: 1m
variables:
  pressure:
    scope: room:office:desk
    range: 0..1
rules:
  hello:
    when:
      event: wake.recommended
      scope: room:office:desk
    do:
      - action: moltnet:message
        to: room:office:desk
        content: "Bound"
`, "utf8");
    await writeFile(report, JSON.stringify({
      nodes: [
        { id: "agent:helper" },
        {
          id: "team:ops",
          active_environments: {
            moltnet: {
              office: { rooms: { desk: {} } }
            }
          }
        }
      ]
    }), "utf8");

    const code = await runCli(["validate", "--spawnfile-report", report, file]);
    assert.equal(code, 0);
  });

  it("rejects unknown Spawnfile references", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-cli-binding-fail-"));
    const file = path.join(dir, "Simfile.yaml");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-world
clock:
  seed: cli-test
  tick: 1m
rules:
  hello:
    when:
      event: wake.recommended
      target: room:office:missing-room
    do:
      - action: moltnet:message
        to: room:office:desk
        content: "Nope"
`, "utf8");

    const code = await runCli(["validate", "--json", "--spawnfile-report", "{}",
      file]);
    assert.equal(code, 1);
  });

  it("rejects missing paths", async () => {
    const code = await runCli(["validate"]);
    assert.equal(code, 1);
  });

  it("runs a Simfile into a sealed run record directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-cli-"));
    const file = path.join(dir, "Simfile.yaml");
    const out = path.join(dir, "runs", "smoke");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-run-world
clock:
  seed: cli-test
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
      - action: wake:recommend
        to: room:office-floor:case-warroom
probes:
  deadline_seen:
    when:
      event: wake.recommended
      target: room:office-floor:case-warroom
    expect:
      at_least: 1
`, "utf8");

    const code = await runCli(["run", file, "--ticks", "4", "--out", out, "--run-id", "smoke"]);
    assert.equal(code, 0);
    await stat(path.join(out, "manifest.yaml"));
    const ledger = await readFile(path.join(out, "ledger.jsonl"), "utf8");
    assert.match(ledger, /"kind":"wake.recommended"/);
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8")) as { probes: Array<{ passed: boolean }> };
    assert.equal(report.probes[0]?.passed, true);
    const telemetry = JSON.parse(await readFile(path.join(out, "telemetry.json"), "utf8")) as {
      samples: Array<{ tick: number }>;
      snapshot_every?: number;
    };
    assert.equal(telemetry.snapshot_every, 2);
    assert.deepEqual(telemetry.samples.map((sample) => sample.tick), [0, 2, 3]);
    const viewerTrace = JSON.parse(await readFile(path.join(out, "viewer-trace.json"), "utf8")) as { rooms: unknown[] };
    assert.equal(viewerTrace.rooms.length, 1);
  });

  it("optionally exports a Moltnet transcript artifact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-cli-moltnet-"));
    const file = path.join(dir, "Simfile.yaml");
    const out = path.join(dir, "runs", "smoke");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-run-world
clock:
  seed: cli-test
  tick: 1m
variables:
  pressure:
    scope: room:office-floor:case-warroom
    initial: 0.8
    range: 0..1
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
      - action: moltnet:dm
        to: agent:eleanor
        content: "Private follow-up."
      - action: wake:recommend
        to: room:office-floor:case-warroom
markers:
  tenant_name:
    text:
      - "Rosa Delgado"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
`, "utf8");

    const code = await runCli([
      "run",
      file,
      "--ticks",
      "4",
      "--out",
      out,
      "--run-id",
      "smoke",
      "--moltnet-artifact",
      "transcript"
    ]);
    assert.equal(code, 0);

    const manifest = await readFile(path.join(out, "manifest.yaml"), "utf8");
    assert.match(manifest, /moltnet: moltnet-transcript\.json/);

    const transcript = JSON.parse(await readFile(path.join(out, "moltnet-transcript.json"), "utf8")) as {
      entries: Array<{ event_id: string; kind: string; marker_ids: string[]; text?: string }>;
      version: string;
    };
    assert.equal(transcript.version, "simfile.moltnet.transcript.v1");
    assert.deepEqual(
      transcript.entries.map((entry) => entry.kind),
      ["world.message", "world.dm", "wake.recommended"]
    );
    assert.deepEqual(
      transcript.entries.find((entry) => entry.kind === "world.message")
        && (({ event_id, kind, marker_ids, text }) => ({ event_id, kind, marker_ids, text }))(transcript.entries.find((entry) => entry.kind === "world.message")!),
      {
        event_id: "smoke:3",
        kind: "world.message",
        marker_ids: ["tenant_name"],
        text: "Rosa Delgado belongs here."
      }
    );
  });

  it("rejects invalid Moltnet artifact selections", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-cli-moltnet-bad-"));
    const file = path.join(dir, "Simfile.yaml");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-run-world
clock:
  seed: cli-test
  tick: 1m
`, "utf8");

    const code = await runCli(["run", file, "--ticks", "1", "--moltnet-artifact", "bogus"]);
    assert.equal(code, 1);
  });

  it("runs a Simfile with Spawnfile binding checks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "simfile-run-cli-bound-"));
    const file = path.join(dir, "Simfile.yaml");
    const out = path.join(dir, "runs", "smoke");
    const report = path.join(dir, "spawnfile-report.json");
    await writeFile(file, `
simfile_version: "0.1"
name: cli-run-bound
clock:
  seed: cli-test
  tick: 1m
variables:
  pressure:
    scope: room:office-floor:case-warroom
    initial: 0.8
    range: 0..1
rules:
  deadline:
    when:
      variable: pressure
      above: 0.85
    do:
      - action: wake:recommend
        to: room:office-floor:case-warroom
`, "utf8");
    await writeFile(report, JSON.stringify({
      nodes: [
        {
          id: "agent:agent-a",
          active_environments: {
            moltnet: {
              "office-floor": { rooms: { "case-warroom": {} } }
            }
          }
        },
        { id: "team:office" }
      ]
    }), "utf8");

    const code = await runCli(["run", file, "--ticks", "1", "--out", out, "--run-id", "smoke", "--spawnfile-report", report]);
    assert.equal(code, 0);
    await stat(path.join(out, "manifest.yaml"));
  });
});
