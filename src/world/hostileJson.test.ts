import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMICS_LIMITS } from "../dynamics/limits.js";
import { copyHostileJson } from "./hostileJson.js";

const rejectsWithoutTrap = (value: unknown, traps: { count: number }): void => {
  assert.throws(() => copyHostileJson(value));
  assert.equal(traps.count, 0);
};

test("copies accepted JSON into canonical isolated frozen data", () => {
  const source = { zed: { value: 1 }, first: [{ value: 2 }, { value: 3 }] };
  const copy = copyHostileJson(source) as Record<string, any>;
  assert.deepEqual(Object.keys(copy), ["first", "zed"]);
  assert.equal(Object.getPrototypeOf(copy), null);
  assert.equal(Object.getPrototypeOf(copy.zed), null);
  assert(Object.isFrozen(copy));
  assert(Object.isFrozen(copy.zed));
  assert(Object.isFrozen(copy.first));
  assert.equal(Object.getPrototypeOf(copy.first[0]), null);
  assert.equal(Object.getPrototypeOf(copy.first), Array.prototype);
  source.zed.value = 9;
  source.first[0]!.value = 8;
  assert.equal(copy.first[0].value, 2);
  assert.equal(copy.first[1].value, 3);
  assert.equal(copy.zed.value, 1);
  assert.notEqual(copy.first[0], copy.first[1]);
});

test("rejects reflection hazards without invoking hostile code", () => {
  const traps = { count: 0 };
  const proxy = new Proxy({}, {
    get: () => { traps.count += 1; return 1; },
    getOwnPropertyDescriptor: () => { traps.count += 1; return undefined; },
    ownKeys: () => { traps.count += 1; return []; },
  });
  rejectsWithoutTrap(proxy, traps);

  const getter = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get: () => { traps.count += 1; return 1; },
  });
  rejectsWithoutTrap(getter, traps);

  const symbol = { value: 1 } as Record<PropertyKey, unknown>;
  symbol[Symbol("authority")] = true;
  rejectsWithoutTrap(symbol, traps);
  rejectsWithoutTrap(Object.assign(Object.create({ inherited: 1 }), { value: 1 }), traps);
  rejectsWithoutTrap(Object.create({ then: 1 }), traps);
  rejectsWithoutTrap({ then: 1 }, traps);
  const previousThen = Object.getOwnPropertyDescriptor(Object.prototype, "then");
  Object.defineProperty(Object.prototype, "then", { configurable: true, value: 1 });
  try {
    rejectsWithoutTrap({ value: 1 }, traps);
  } finally {
    if (previousThen === undefined) delete (Object.prototype as { then?: unknown }).then;
    else Object.defineProperty(Object.prototype, "then", previousThen);
  }
  rejectsWithoutTrap({ __proto__: null, constructor: 1 }, traps);
  rejectsWithoutTrap({ __proto__: null, prototype: 1 }, traps);
});

test("rejects malformed arrays, aliases, cycles, and unsupported values", () => {
  const traps = { count: 0 };
  rejectsWithoutTrap([, 1], traps);
  const nonIndex = [1];
  Object.defineProperty(nonIndex, "01", { enumerable: true, value: 1 });
  rejectsWithoutTrap(nonIndex, traps);
  const shared = { value: 1 };
  rejectsWithoutTrap([shared, shared], traps);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  rejectsWithoutTrap(cycle, traps);
  for (const value of [undefined, Symbol("x"), 1n, () => 1, NaN, Infinity, -Infinity]) {
    rejectsWithoutTrap(value, traps);
  }
});

test("enforces depth, node, individual-string, and cumulative budgets", () => {
  const traps = { count: 0 };
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let index = 0; index <= DYNAMICS_LIMITS.json_depth; index += 1) {
    const next: Record<string, unknown> = {};
    deep.child = next;
    deep = next;
  }
  rejectsWithoutTrap(root, traps);
  rejectsWithoutTrap(Array.from({ length: DYNAMICS_LIMITS.json_nodes }, () => null), traps);
  rejectsWithoutTrap("x".repeat(DYNAMICS_LIMITS.json_string_length + 1), traps);
  const cumulative: Record<string, string> = Object.create(null);
  const chunk = "x".repeat(DYNAMICS_LIMITS.json_string_length);
  cumulative.a = chunk;
  cumulative.b = chunk;
  cumulative.c = chunk;
  cumulative.d = chunk;
  rejectsWithoutTrap(cumulative, traps);
  assert.equal(traps.count, 0);
});
