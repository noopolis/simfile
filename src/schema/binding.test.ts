import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSimfileSource } from "./parse.js";
import {
  createBindingDiagnostics,
  createReportScopeIndex,
  loadSpawnfileReport,
  parseSpawnfileReportJson
} from "./binding.js";

describe("simfile binding diagnostics", () => {
  it("collects agent, team, and room references from a Spawnfile report", () => {
    const index = createReportScopeIndex({
      nodes: [
        { id: "agent:alpha" },
        { id: "team:ops" },
        {
          id: "agent:beta",
          active_environments: {
            moltnet: {
              lab: {
                rooms: {
                  "war-room": {},
                  lounge: {}
                }
              }
            }
          }
        }
      ]
    });

    assert.equal(index.agents.size, 2);
    assert.equal(index.teams.size, 1);
    assert.ok(index.rooms.has("room:lab:war-room"));
    assert.ok(index.rooms.has("room:lab:lounge"));
  });

  it("returns errors for unknown references", () => {
    const simfile = parseSimfileSource(`
simfile_version: "0.1"
name: binding-world
clock:
  seed: binding
  tick: 1m
variables:
  pressure:
    scope: room:lab:war-room
    range: 0..1
rules:
  alert:
    when:
      event: world.message
      target: room:lab:archive
      scope: room:lab:archive
    do:
      - action: moltnet:dm
        to: agent:ghost
        content: "Ghost"
      - action: moltnet:message
        to: room:lab:lobby
        content: "Observation notice."
markers:
  war:
    mode: containment
    scopes:
      - team:missing-team
      - room:lab:war-room
probes:
  alert_probe:
    when:
      event: world.message
      actor: agent:missing-agent
    expect:
      at_least: 1
`, { path: "Simfile.yaml" }).simfile;

    const diagnostics = createBindingDiagnostics(simfile, {
      nodes: [
        {
          id: "agent:alpha",
          active_environments: {
            moltnet: {
              lab: {
                rooms: {
                  "war-room": {}
                }
              }
            }
          }
        },
        { id: "team:ops" }
      ]
    });

    const messages = diagnostics.map((entry) => entry.message);
    assert.equal(diagnostics.length, 6);
    assert.ok(messages.includes('rule "alert" event target references unknown room room:lab:archive'));
    assert.ok(messages.includes('rule "alert" event scope references unknown room room:lab:archive'));
    assert.ok(messages.includes('rule "alert" action moltnet:dm target references unknown agent agent:ghost'));
    assert.ok(messages.includes('rule "alert" action moltnet:message target references unknown room room:lab:lobby'));
    assert.ok(messages.includes('marker "war" scope references unknown team team:missing-team'));
    assert.ok(messages.includes('probe "alert_probe" event actor references unknown agent agent:missing-agent'));
    assert.ok(diagnostics.every((entry) => entry.level === "error"));
  });

  it("parses inline JSON and file-based Spawnfile reports", async () => {
    const inlineReport = parseSpawnfileReportJson(JSON.stringify({ nodes: [{ id: "agent:alpha" }] }));
    assert.equal(createReportScopeIndex(inlineReport).agents.has("alpha"), true);

    const directory = await mkdtemp(path.join(tmpdir(), "simfile-bindings-"));
    const file = path.join(directory, "spawnfile-report.json");
    await writeFile(file, JSON.stringify({ nodes: [{ id: "agent:beta" }] }), "utf8");
    const fileReport = await loadSpawnfileReport(file);
    const fileText = await readFile(file, "utf8");
    const duplicateReport = await loadSpawnfileReport(fileText);

    assert.equal(createReportScopeIndex(fileReport).agents.has("beta"), true);
    assert.equal(createReportScopeIndex(duplicateReport).agents.has("beta"), true);
  });
});
