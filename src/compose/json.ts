import { createHash } from "node:crypto";
import { types } from "node:util";

const MAX_DEPTH = 32;
const MAX_NODES = 4_096;
const MAX_KEYS = 256;
// Composed bootstrap contains a schema-bounded base64 world archive (4 MiB raw).
const MAX_STRING_BYTES = 6_291_456;
const forbiddenKey = /^(?:authorization|bearer|credential|password|private_config|secret|target_config|token)$/iu;
const secretValue = /(?:\bBearer\s+\S+|\b(?:password|token)\s*=|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,})/u;

export const assertOrdinaryComposedJson = (raw: unknown): void => {
  const seen = new WeakSet<object>();
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: raw }];
  let nodes = 0;
  let stringBytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    const value = item.value;
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      if (stringBytes > MAX_STRING_BYTES) throw new TypeError("invalid composed JSON graph");
      continue;
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("invalid composed JSON graph");
      continue;
    }
    if (typeof value !== "object" || types.isProxy(value) || item.depth > MAX_DEPTH
      || seen.has(value)) throw new TypeError("invalid composed JSON graph");
    seen.add(value);
    nodes += 1;
    if (nodes > MAX_NODES) throw new TypeError("invalid composed JSON graph");
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || value.length > MAX_KEYS
        || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError("invalid composed JSON graph");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("invalid composed JSON graph");
        }
        pending.push({ depth: item.depth + 1, value: descriptor.value });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("invalid composed JSON graph");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_KEYS) throw new TypeError("invalid composed JSON graph");
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("invalid composed JSON graph");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("invalid composed JSON graph");
      }
      stringBytes += Buffer.byteLength(key, "utf8");
      pending.push({ depth: item.depth + 1, value: descriptor.value });
    }
  }
};

export const assertSecretFreeComposedJson = (raw: unknown): void => {
  assertOrdinaryComposedJson(raw);
  const pending: unknown[] = [raw];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (secretValue.test(value)) throw new TypeError("secret-shaped composed value");
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (forbiddenKey.test(key)) throw new TypeError("secret-shaped composed field");
        pending.push(nested);
      }
    }
  }
};

export const canonicalComposedJson = (raw: unknown): string => {
  assertOrdinaryComposedJson(raw);
  if (Array.isArray(raw)) return `[${raw.map(canonicalComposedJson).join(",")}]`;
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalComposedJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(raw);
  if (serialized === undefined) throw new TypeError("invalid composed JSON value");
  return serialized;
};

export const digestComposedJson = (domain: string, raw: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`${domain}\0`, "utf8")
    .update(canonicalComposedJson(raw), "utf8").digest("hex")}`;
