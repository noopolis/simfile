import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateContainmentMarker,
  evaluatePropagationMarker,
  scanMarker,
  scanMarkers
} from "./markers.js";

import type { LedgerEvent, MarkerDefinition } from "./markers.js";

const messageEvents: LedgerEvent[] = [
  {
    event_id: "run:1",
    kind: "world.message",
    sim_time: 10,
    scope: "room:office-floor:case-warroom",
    payload: { content: "The witness is Rosa Delgado." }
  },
  {
    event_id: "run:2",
    kind: "world.message",
    sim_time: 20,
    scope: "room:office-floor:hall",
    payload: { content: "Someone said full moon over the office." }
  },
  {
    event_id: "run:3",
    kind: "world.message",
    sim_time: 30,
    scope: "team:office",
    payload: { content: "Rosa Delgado entered the room." }
  }
];

const tenantMarker: MarkerDefinition = {
  text: ["Rosa Delgado"],
  mode: "containment",
  scopes: ["room:office-floor:case-warroom", "team:office"]
};

describe("scanMarker", () => {
  it("matches aliases case-insensitively across payload content", () => {
    const result = scanMarker(messageEvents, "tenant_name", tenantMarker);
    assert.equal(result.hits.length, 2);
    assert.ok(result.hits.some((hit) => hit.eventId === "run:1"));
    assert.ok(result.hits.some((hit) => hit.eventId === "run:3"));
  });

  it("supports default marker text fallback to marker id", () => {
    const marker: MarkerDefinition = {
      mode: "propagation",
      scopes: ["room:office-floor:hall"]
    };
    const result = scanMarker(messageEvents, "secret-code", {
      ...marker,
      text: []
    });
    assert.equal(result.hits.length, 0);
  });
});

describe("scanMarkers", () => {
  it("scans multiple markers", () => {
    const hits = scanMarkers(messageEvents, {
      tenant_name: tenantMarker,
      moon_phrase: {
        mode: "propagation",
        scopes: ["room:office-floor:hall"],
        text: ["full moon over the office"]
      }
    });
    assert.equal(hits.tenant_name.length, 2);
    assert.equal(hits.moon_phrase.length, 1);
  });
});

describe("marker evaluation", () => {
  it("evaluates containment markers", () => {
    const hits = scanMarker(messageEvents, "tenant_name", tenantMarker).hits;
    const result = evaluateContainmentMarker("tenant_name", tenantMarker, hits);
    assert.equal(result.passed, true);
  });

  it("evaluates propagation markers", () => {
    const propagation = scanMarker(messageEvents, "moon_phrase", {
      text: ["full moon"],
      mode: "propagation",
      scopes: ["room:office-floor:hall"]
    }).hits;
    const result = evaluatePropagationMarker("moon_phrase", {
      text: ["full moon"],
      mode: "propagation",
      scopes: ["room:office-floor:hall", "room:office-floor:break-room"]
    }, propagation);
    assert.equal(result.passed, true);
  });

  it("requires all scopes when requested", () => {
    const propagation = [
      { markerId: "moon_phrase", eventId: "run:2", eventKind: "world.message", scope: "room:office-floor:hall", simTime: 20, alias: "full moon" },
      { markerId: "moon_phrase", eventId: "run:4", eventKind: "world.message", scope: "room:office-floor:hall", simTime: 22, alias: "full moon" }
    ];
    const result = evaluatePropagationMarker("moon_phrase", {
      text: ["full moon"],
      mode: "propagation",
      scopes: ["room:office-floor:hall", "room:office-floor:break-room"]
    }, propagation, { requireAllScopes: true });
    assert.equal(result.passed, false);
  });
});
