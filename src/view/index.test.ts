import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseViewArguments } from "./index.js";

describe("parseViewArguments", () => {
  it("parses live view state options", () => {
    const parsed = parseViewArguments(["--state", ".sim", "--port", "18787", "--no-open"]);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.options?.statePath, ".sim");
    assert.equal(parsed.options?.port, 18787);
    assert.equal(parsed.options?.openBrowser, false);
  });

  it("parses replay directories as the source path", () => {
    const parsed = parseViewArguments(["runs/latest"]);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.options?.sourcePath, "runs/latest");
    assert.equal(parsed.options?.statePath, undefined);
  });

  it("rejects unsafe ports and duplicate positional paths", () => {
    assert.match(parseViewArguments(["--port", "22"]).error ?? "", /Invalid value/);
    assert.match(parseViewArguments(["one", "two"]).error ?? "", /Unexpected positional/);
  });
});
