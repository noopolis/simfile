import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { encodeWorldActEnvelope, parseWorldActEnvelope, WORLD_ACT_ENVELOPE_VERSION } from "./actEnvelope.js";

const request = (input: unknown = { direction: 1, intensity: 0.5 }) => ({
  request_id: "request-1", affordance: "world://pitch/affordance/kick", target: "world://pitch/entity/red", input,
});
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array | readonly number[]): string => new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
const rejects = (input: unknown): void => assert.throws(() => parseWorldActEnvelope(input), TypeError);

test("canonical action envelopes round-trip with byte stability", () => {
  const encoded = encodeWorldActEnvelope(request({ z: 1, a: "é" }));
  const parsed = parseWorldActEnvelope(encoded);
  assert.equal(parsed.version, WORLD_ACT_ENVELOPE_VERSION);
  assert.equal(parsed.request_id, "request-1");
  assert.deepEqual({ ...(parsed.input as Record<string, unknown>) }, { a: "é", z: 1 });
  assert.equal(textOf(encoded), textOf(parsed.bytes));
  assert.deepEqual(parseWorldActEnvelope(Buffer.from(encoded)), parsed);
  assert.equal(Object.isFrozen(parsed.bytes), true);
  assert.throws(() => (parsed.bytes as number[])[0] = 0, TypeError);
  encoded[0] ^= 1;
  assert.notEqual(encoded[0], parsed.bytes[0]);
});

test("the encoder copies hostile JSON and admits only the four semantic input fields", () => {
  const input = { nested: { value: 1 } };
  const encoded = encodeWorldActEnvelope({ ...request(input) });
  input.nested.value = 9;
  assert.match(textOf(encoded), /"value":1/u);
  for (const hostile of [
    { ...request(), principal: "p" },
    { ...request(), input: { __proto__: { polluted: true } } },
    { ...request(), input: new Date() },
    { ...request(), input: { get value() { throw new Error("accessor"); } } },
    { ...request(), input: new Uint8Array([1]) },
  ]) assert.throws(() => encodeWorldActEnvelope(hostile), TypeError);
  const proxy = new Proxy(request(), {});
  assert.throws(() => encodeWorldActEnvelope(proxy), TypeError);
  const aliased: Record<string, unknown> = { value: 1 };
  assert.throws(() => encodeWorldActEnvelope({ ...request(), input: [aliased, aliased] }), TypeError);
});

test("parser rejects noncanonical framing, schema, duplicate keys, and UTF-8", () => {
  const canonical = textOf(encodeWorldActEnvelope(request()));
  for (const text of [
    ` ${canonical}`,
    canonical.replace("\"affordance\"", "\"target\""),
    canonical.replace(`"${WORLD_ACT_ENVELOPE_VERSION}"`, `"other.v1"`),
    canonical.replace(/\}\n$/u, ",\"extra\":true}\n"),
    canonical.replace(/,"target"/u, ""),
    canonical.replace(/"request_id":"request-1"/u, `"request_id":"request-1","request_id":"other"`),
  ]) rejects(bytesOf(text));
  rejects(bytesOf(`{"version":"${WORLD_ACT_ENVELOPE_VERSION}","request_id":"request-1","affordance":"a","target":"b","input":1}\n\n`));
  rejects(Uint8Array.from([0xc3, 0x28]));
  class ByteSubclass extends Uint8Array {}
  rejects(new ByteSubclass(encodeWorldActEnvelope(request())));
  rejects(new Proxy(encodeWorldActEnvelope(request()), {}));
});

test("request ids and addresses are bounded nonblank strings", () => {
  for (const bad of [
    { ...request(), request_id: "" }, { ...request(), request_id: " " },
    { ...request(), request_id: "x".repeat(257) }, { ...request(), affordance: 1 },
    { ...request(), target: "" }, { ...request(), target: "x".repeat(257) },
  ]) assert.throws(() => encodeWorldActEnvelope(bad), TypeError);
});
