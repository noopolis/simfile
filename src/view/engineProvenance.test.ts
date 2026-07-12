import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyEngineName, computeEngineProvenance } from "./engineProvenance.js";

describe("classifyEngineName", () => {
  it("classifies scripted/fake-* engines as scripted", () => {
    assert.equal(classifyEngineName("scripted"), "scripted");
    assert.equal(classifyEngineName("fake-grok-office-sim"), "scripted");
    assert.equal(classifyEngineName("FAKE-Codex"), "scripted");
  });

  it("classifies named real model engines as real-engine", () => {
    assert.equal(classifyEngineName("grok"), "real-engine");
    assert.equal(classifyEngineName("codex"), "real-engine");
    assert.equal(classifyEngineName("agy"), "real-engine");
    assert.equal(classifyEngineName("claude"), "real-engine");
    assert.equal(classifyEngineName("grok-4"), "real-engine");
    assert.equal(classifyEngineName("claude-sonnet-4.5"), "real-engine");
  });

  it("classifies an unrecognized engine string as unknown, never real", () => {
    assert.equal(classifyEngineName("mystery-engine"), "unknown");
    assert.equal(classifyEngineName(""), "unknown");
  });

  it("never lets a substring of a real engine name inside an unrelated word false-match", () => {
    assert.equal(classifyEngineName("agyeman"), "unknown");
    assert.equal(classifyEngineName("declaudified"), "unknown");
  });
});

describe("computeEngineProvenance", () => {
  it("is unknown with no entries at all — absence is never assumed real", () => {
    const provenance = computeEngineProvenance([]);
    assert.equal(provenance.mode, "unknown");
    assert.deepEqual(provenance.engines, []);
    assert.match(provenance.label, /UNKNOWN/);
    assert.match(provenance.label, /do not assume real/i);
  });

  it("classifies a single fake-* manifest engine as scripted, worded as authored/not-emergent", () => {
    const provenance = computeEngineProvenance([{ engine: "fake-grok-office-sim" }]);
    assert.equal(provenance.mode, "scripted");
    assert.match(provenance.label, /SCRIPTED/);
    assert.match(provenance.label, /authored/i);
    assert.match(provenance.label, /not emergent/i);
  });

  it("classifies a single 'scripted' manifest engine as scripted", () => {
    const provenance = computeEngineProvenance([{ engine: "scripted" }]);
    assert.equal(provenance.mode, "scripted");
  });

  it("classifies a single named real engine as real-engine, labeled with its name", () => {
    const provenance = computeEngineProvenance([{ engine: "grok" }]);
    assert.equal(provenance.mode, "real-engine");
    assert.match(provenance.label, /REAL ENGINE/);
    assert.match(provenance.label, /grok/);
  });

  it("classifies per-agent real engines that agree (grok everywhere) as real-engine even with multiple entries", () => {
    const provenance = computeEngineProvenance([
      { agent: "eleanor", engine: "grok" },
      { agent: "sam", engine: "grok" },
    ]);
    assert.equal(provenance.mode, "real-engine");
    assert.match(provenance.label, /grok/);
  });

  it("classifies a mix of scripted and real-engine agents as mixed, naming each agent", () => {
    const provenance = computeEngineProvenance([
      { agent: "eleanor", engine: "grok" },
      { agent: "sam", engine: "scripted" },
    ]);
    assert.equal(provenance.mode, "mixed");
    assert.match(provenance.label, /MIXED/);
    assert.match(provenance.label, /eleanor/);
    assert.match(provenance.label, /sam/);
  });

  it("classifies an absent/unrecognized engine field as unknown, never real, when it is the only entry", () => {
    const provenance = computeEngineProvenance([{ engine: "n/a-piece2-golden-capture" }]);
    assert.equal(provenance.mode, "unknown");
  });

  it("treats a mix of real and unknown as mixed rather than silently upgrading unknown to real", () => {
    const provenance = computeEngineProvenance([
      { agent: "eleanor", engine: "grok" },
      { agent: "sam", engine: "mystery-engine" },
    ]);
    assert.equal(provenance.mode, "mixed");
  });
});
