import assert from "node:assert/strict";
import test from "node:test";

import type { BoundedJsonSchemaNode } from "./types.js";
import { readWorldSurfaceRejection } from "./rejection.js";
import { validateBoundedJsonValue } from "./schema-value.js";

test("unknown caller-authored property names are omitted from bounded rejection details", () => {
  const hostile = "<script>PWNED</script>";
  const schema = {
    additionalProperties: false,
    maxProperties: 2,
    properties: {
      declared: { maximum: 1, minimum: 0, type: "number" },
    },
    type: "object",
  } as const as BoundedJsonSchemaNode;

  assert.throws(
    () => validateBoundedJsonValue(schema, { declared: 1, [hostile]: "hostile-value" }, "value"),
    (error: unknown) => {
      const detail = readWorldSurfaceRejection(error);
      assert.deepEqual(detail, { reason: "action_input_unknown_field" });
      assert.equal(detail?.fieldPath, undefined);
      assert.equal(JSON.stringify(detail).includes(hostile), false);
      return true;
    },
  );
});
