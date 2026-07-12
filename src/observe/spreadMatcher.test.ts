import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EDIT_DISTANCE,
  InvalidSpreadMatcherPolicyError,
  UnsupportedSpreadMatcherPolicyError,
  levenshteinDistance,
  matchSeedSpread,
  parseSpreadMatcherPolicy
} from "./spreadMatcher.js";

describe("matchSeedSpread — exact", () => {
  it("preserves word-boundary exact matching with fidelity 1", () => {
    assert.deepEqual(matchSeedSpread("The ROSA DELGADO account.", ["Rosa Delgado"], "exact"), {
      matched: true,
      fidelity: 1
    });
    assert.deepEqual(matchSeedSpread("Rosalind", ["Rosa"], "exact"), { matched: false, fidelity: 0 });
  });
});

describe("parseSpreadMatcherPolicy", () => {
  it("parses exact, the default edit-distance bound, and explicit bounds", () => {
    assert.deepEqual(parseSpreadMatcherPolicy("exact"), { kind: "exact" });
    assert.deepEqual(parseSpreadMatcherPolicy("edit-distance"), {
      kind: "edit-distance",
      maxDistance: DEFAULT_EDIT_DISTANCE
    });
    assert.deepEqual(parseSpreadMatcherPolicy(" edit-distance : 1 "), {
      kind: "edit-distance",
      maxDistance: 1
    });
    assert.deepEqual(parseSpreadMatcherPolicy("edit-distance≤0"), {
      kind: "edit-distance",
      maxDistance: 0
    });
  });

  it("rejects malformed or unsafe edit-distance bounds", () => {
    for (const policy of ["edit-distance:", "edit-distance:-1", "edit-distance:1.5", "edit-distance:999999999999999999999"]) {
      assert.throws(() => parseSpreadMatcherPolicy(policy), InvalidSpreadMatcherPolicyError);
    }
  });
});

describe("matchSeedSpread — edit-distance", () => {
  it("matches a multiword typo within k", () => {
    assert.equal(matchSeedSpread("The Rosa Delgato account.", ["Rosa Delgado"], "edit-distance:1").matched, true);
  });

  it("matches a retained-name paraphrase when that alias is pinned in the token set", () => {
    assert.deepEqual(matchSeedSpread("This is the Delgado account.", ["Rosa Delgado", "Delgado"], "edit-distance:1"), {
      matched: true,
      fidelity: 1
    });
  });

  it("does not match a multiword token beyond k even when one word is exact", () => {
    assert.deepEqual(matchSeedSpread("The Rosa Delxxxo account.", ["Rosa Delgado"], "edit-distance:1"), {
      matched: false,
      fidelity: 0
    });
  });

  it("applies the default k=2 bound when the policy omits k", () => {
    assert.equal(matchSeedSpread("Rosa Delgxto", ["Rosa Delgado"], "edit-distance").matched, true);
    assert.equal(matchSeedSpread("Rosa Delgxto", ["Rosa Delgado"], "edit-distance:1").matched, false);
  });

  it("uses one minus distance over the longer token length for fidelity", () => {
    const result = matchSeedSpread("Rosa Delgato", ["Rosa Delgado"], "edit-distance:1");
    assert.equal(levenshteinDistance("rosa delgato", "rosa delgado"), 1);
    assert.equal(result.fidelity, 1 - 1 / 12);
  });

  it("uses the highest fidelity among qualifying token candidates", () => {
    assert.deepEqual(matchSeedSpread("Delgato then Delgado", ["Delgado"], "edit-distance:1"), {
      matched: true,
      fidelity: 1
    });
  });
});

describe("matchSeedSpread — model-backed policies", () => {
  it("fails loudly with a typed unsupported signal for embedding", () => {
    assert.throws(
      () => matchSeedSpread("Rosa Delgado", ["Rosa Delgado"], "embedding"),
      (error) =>
        error instanceof UnsupportedSpreadMatcherPolicyError &&
        error.policy === "embedding" &&
        /unsupported policy in this build/u.test(error.message)
    );
  });

  it("fails loudly with a typed unsupported signal for judge", () => {
    assert.throws(
      () => matchSeedSpread("Rosa Delgado", ["Rosa Delgado"], "judge"),
      (error) => error instanceof UnsupportedSpreadMatcherPolicyError && error.policy === "judge"
    );
  });
});
