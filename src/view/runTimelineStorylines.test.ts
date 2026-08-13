import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRunTimeline } from "./runTimeline.js";
import type { RunTimelineElementKind } from "./runTimelineTypes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(
  here, "..", "..", "fixtures", "observe", "office-sim-golden",
);
const VARIABLE_GOLDEN_DIR = path.resolve(
  here, "..", "..", "fixtures", "observe", "office-pressure-v0-golden",
);

describe("buildRunTimeline — variable storyline (buildWorldRecord, increment 4)", () => {
  it("enumerates a variable element for filing_pressure, derived from its own records (not a separate schema/telemetry read)", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const variableElement = timeline.elements.find((element) => element.ref === "variable:filing_pressure");
    assert.ok(variableElement, "expected a variable:filing_pressure element");
    assert.equal(variableElement!.kind, "variable");
    assert.equal(variableElement!.label, "filing_pressure");
  });

  it("attributes the threshold rule's rule.fired and its resulting world.message to variable:filing_pressure, alongside the room", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const pressureFired = timeline.events.find(
      (event) => event.type === "rule.fired" && (event.payload as { rule?: string }).rule === "pressure_alert",
    );
    assert.ok(pressureFired, "expected pressure_alert's rule.fired event");
    assert.ok(pressureFired!.subjects.includes("variable:filing_pressure"));
    assert.ok(pressureFired!.subjects.includes("room:office_lab:office-room"));

    const pressureMessage = timeline.events.find(
      (event) => event.viewClass === "message" && event.authority === "world" && (event.text ?? "").includes("Deadline pressure is high"),
    );
    assert.ok(pressureMessage, "expected the pressure_alert world.message event");
    assert.ok(pressureMessage!.subjects.includes("variable:filing_pressure"));
  });

  it("never attributes a plain clock.sync tick (or the unrelated kickoff rule) to the variable — no fabricated subject", async () => {
    const timeline = await buildRunTimeline(VARIABLE_GOLDEN_DIR);
    const clockEvents = timeline.events.filter((event) => event.type === "clock.sync");
    assert.ok(clockEvents.length > 0);
    for (const event of clockEvents) {
      assert.equal(event.subjects.includes("variable:filing_pressure"), false);
    }

    const kickoffFired = timeline.events.find(
      (event) => event.type === "rule.fired" && (event.payload as { rule?: string }).rule === "kickoff",
    );
    assert.ok(kickoffFired, "expected kickoff's rule.fired event");
    assert.equal(kickoffFired!.subjects.includes("variable:filing_pressure"), false);
  });

  it("has no variable elements at all for a run with no world stream (office-sim-golden, graceful absence)", async () => {
    const timeline = await buildRunTimeline(GOLDEN_DIR);
    assert.equal(timeline.elements.some((element) => element.kind === "variable"), false);
  });
});

const JUNGIAN_GOLDEN_DIR = path.resolve(here, "..", "..", "fixtures", "observe", "jungian-daimon-org-golden");

describe("buildRunTimeline — jungian psyche golden (multi-network membranes)", () => {
  it("derives a membrane per interior self-team from the run's compile report", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    assert.deepEqual((timeline.membranes ?? []).map((m) => m.ref), ["team:luna", "team:selene"]);
    const luna = (timeline.membranes ?? []).find((m) => m.ref === "team:luna");
    assert.equal(luna?.representative, "agent:luna-representative");
    assert.deepEqual(luna?.interiorRooms, ["room:luna_inner:luna-council"]);
  });

  it("enumerates team elements alongside each network's room element", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const byKind = (kind: RunTimelineElementKind) => timeline.elements.filter((e) => e.kind === kind).map((e) => e.ref).sort();
    assert.deepEqual(byKind("team"), ["team:luna", "team:selene"]);
    assert.ok(byKind("room").includes("room:luna_inner:luna-council"));
    assert.ok(byKind("room").includes("room:psyche-floor:commons"));
  });

  it("attributes an inner-council message to its own network room, not the floor (the multi-network subject fix)", async () => {
    const timeline = await buildRunTimeline(JUNGIAN_GOLDEN_DIR);
    const councilMessages = timeline.events.filter(
      (e) => e.viewClass === "message" && e.subjects.includes("room:luna_inner:luna-council"),
    );
    // The representative's inward convene + the animus + the shadow replies all live in the council room.
    assert.ok(councilMessages.length >= 3, `expected >=3 council messages, got ${councilMessages.length}`);
    // No council message ever leaks onto the floor room.
    assert.ok(!councilMessages.some((e) => e.subjects.includes("room:psyche-floor:commons")));
    // The floor carries the representative's synthesis answer, not the council chatter.
    const floorSynthesis = timeline.events.find(
      (e) => e.viewClass === "message" && e.actor === "luna-representative" && e.subjects.includes("room:psyche-floor:commons") && (e.text ?? "").includes("council has spoken"),
    );
    assert.ok(floorSynthesis, "expected the representative's synthesis on the floor");
  });
});
