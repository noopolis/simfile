import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyEngineName,
  computeEngineProvenance,
  decisionSourceClassification,
  decisionSourceFromUnknown,
  type DecisionSource
} from "./engineProvenance.js";

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
  const scriptedDecisionSource: DecisionSource = {
    kind: "agent",
    live_acceptance: false,
    model_decisions: false,
    provenance: "scripted"
  };

  const liveDecisionSource: DecisionSource = {
    kind: "agent",
    live_acceptance: true,
    model_decisions: true,
    provenance: "live"
  };

  it("uses the record's scripted decision_source instead of a local-looking engine hint", () => {
    const provenance = computeEngineProvenance([{ engine: "simfile.dynamics.local" }], scriptedDecisionSource);
    assert.equal(provenance.mode, "scripted");
    assert.match(provenance.label, /SCRIPTED/);
  });

  it("uses a live, model-decided, accepted decision_source to disclose real-engine", () => {
    const provenance = computeEngineProvenance([{ engine: "simfile.dynamics.local" }], liveDecisionSource);
    assert.equal(provenance.mode, "real-engine");
    assert.match(provenance.label, /REAL ENGINE/);
    assert.match(provenance.label, /simfile\.dynamics\.local/);
  });

  it("does not invent an engine name when live decision_source has no engine entries", () => {
    const provenance = computeEngineProvenance([], liveDecisionSource);
    assert.equal(provenance.mode, "real-engine");
    assert.doesNotMatch(provenance.label, /simfile|grok|codex|agy|claude/i);
  });

  it("keeps an absent decision_source on the unchanged unknown engine path", () => {
    const provenance = computeEngineProvenance([{ engine: "simfile.dynamics.local" }]);
    assert.equal(provenance.mode, "unknown");
    assert.match(provenance.label, /ENGINE UNKNOWN/);
  });

  it("a decision source that states nothing must not be read as stating scripted", () => {
    const local = computeEngineProvenance([{ engine: "simfile.dynamics.local" }], {});
    const named = computeEngineProvenance([{ engine: "grok" }], {});
    assert.equal(local.mode, "unknown");
    assert.equal(named.mode, "real-engine");
  });

  for (const value of ["", " ", "nonsense"]) {
    it(`falls through for unrecognized provenance ${JSON.stringify(value)}`, () => {
      assert.equal(computeEngineProvenance([{ engine: "grok" }], { provenance: value }).mode, "real-engine");
      assert.equal(computeEngineProvenance([{ engine: "simfile.dynamics.local" }], { provenance: value }).mode, "unknown");
    });
  }

  it("classifies provenance scripted explicitly as scripted", () => {
    assert.equal(computeEngineProvenance([], { provenance: "scripted" }).mode, "scripted");
  });

  it("malformed provenance is narrowed away and falls through to engine names", () => {
    const provenance = computeEngineProvenance(
      [{ engine: "simfile.dynamics.local" }],
      decisionSourceFromUnknown({ provenance: 123 })
    );
    assert.equal(provenance.mode, "unknown");
  });

  it("kind alone falls through and never makes a local engine real", () => {
    const provenance = computeEngineProvenance(
      [{ engine: "simfile.dynamics.local" }],
      { kind: "agent" }
    );
    assert.equal(decisionSourceClassification({ kind: "agent" }), undefined);
    assert.equal(provenance.mode, "unknown");
  });

  it("an inconclusive live decision source falls through to the real engine name", () => {
    const provenance = computeEngineProvenance([{ engine: "grok" }], { provenance: "live" });
    assert.equal(provenance.mode, "real-engine");
  });

  it("recorded scripted decision_source beats an engine name that looks real", () => {
    const provenance = computeEngineProvenance([{ engine: "grok" }], scriptedDecisionSource);
    assert.equal(provenance.mode, "scripted");
  });

  it("narrows an untyped decision_source and classifies it from authoritative fields", () => {
    const source = decisionSourceFromUnknown({
      kind: "agent",
      provenance: "scripted",
      model_decisions: false,
      live_acceptance: false
    });
    assert.deepEqual(source, {
      kind: "agent",
      provenance: "scripted",
      model_decisions: false,
      live_acceptance: false
    });
    assert.equal(decisionSourceClassification(source), "scripted");
    assert.equal(decisionSourceClassification(undefined), undefined);
  });

  it("classifies an explicitly rejected live acceptance as scripted", () => {
    const provenance = computeEngineProvenance(
      [{ engine: "grok" }],
      { kind: "agent", provenance: "live", model_decisions: true, live_acceptance: false }
    );
    assert.equal(provenance.mode, "scripted");
  });

  it("the real scripted record shape still beats a real engine name", () => {
    const provenance = computeEngineProvenance([{ engine: "grok" }], scriptedDecisionSource);
    assert.equal(provenance.mode, "scripted");
  });

  it("live provenance with affirmative model decisions and acceptance is real-engine", () => {
    const provenance = computeEngineProvenance([{ engine: "simfile.dynamics.local" }], {
      provenance: "live",
      model_decisions: true,
      live_acceptance: true
    });
    assert.equal(provenance.mode, "real-engine");
  });

  it("a positively stated rejected live acceptance is scripted", () => {
    assert.equal(decisionSourceClassification({ live_acceptance: false }), "scripted");
  });

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
