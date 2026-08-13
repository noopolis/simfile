import assert from "node:assert/strict";
import test from "node:test";

import { parseWorldJson, WORLD_JSON_LIMITS, WorldJsonCodecError } from "./jsonCodec.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const rejects = (input: unknown, code = "world_json_invalid", maximum?: number): void => {
  assert.throws(
    () => parseWorldJson(input, maximum),
    (error: unknown) => error instanceof WorldJsonCodecError
      && error.code === code
      && error.message.length < 64
      && !error.message.includes("secret-canary"),
  );
};

test("parses exactly one bounded JSON value", () => {
  assert.deepEqual(parseWorldJson(bytes(' {"decision_token":"token","input":[1,true,null]}\n')), {
    decision_token: "token",
    input: [1, true, null],
  });
  assert.equal(parseWorldJson(bytes("-12.5e+2")), -1250);
  rejects(bytes(""));
  rejects(bytes("{} {}"));
  rejects(bytes("{} secret-canary"));
  rejects(bytes("[1,]"));
  rejects(bytes("01"));
});

test("rejects duplicate decoded keys at every depth", () => {
  rejects(bytes('{"a":1,"a":2}'));
  rejects(bytes('{"a":1,"\\u0061":2}'));
  rejects(bytes('{"outer":{"secret-canary":1,"secret-canary":2}}'));
  assert.deepEqual(parseWorldJson(bytes('{"left":{"a":1},"right":{"a":2}}')), {
    left: { a: 1 },
    right: { a: 2 },
  });
});

test("rejects malformed UTF-8, a UTF-8 BOM, and excessive nesting", () => {
  rejects(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]));
  rejects(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  rejects(bytes(`${"[".repeat(WORLD_JSON_LIMITS.nesting_depth + 2)}0${"]".repeat(WORLD_JSON_LIMITS.nesting_depth + 2)}`));
});

test("rejects oversized input before decoding and honors tighter caller limits", () => {
  rejects(new Uint8Array(WORLD_JSON_LIMITS.request_bytes + 1), "world_json_too_large");
  rejects(bytes('{"secret-canary":true}'), "world_json_too_large", 4);
  rejects(bytes("{}"), "world_json_invalid", WORLD_JSON_LIMITS.request_bytes + 1);
  rejects("{}", "world_json_invalid");
});
