const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const CAUSAL_RECORDING_JSON_LIMITS = Object.freeze({
  code_units: 112 * 1024 * 1024,
  depth: 32,
  document_bytes: 128 * 1024 * 1024,
  nodes: 2_000_000,
  string_code_units: 96 * 1024 * 1024,
});

interface JsonBudget {
  codeUnits: number;
  nodes: number;
}

const consumeString = (value: string, path: string, budget: JsonBudget): string => {
  if (value.length > CAUSAL_RECORDING_JSON_LIMITS.string_code_units) {
    throw new TypeError(`${path} exceeds the causal recording JSON string limit`);
  }
  budget.codeUnits += value.length;
  if (budget.codeUnits > CAUSAL_RECORDING_JSON_LIMITS.code_units) {
    throw new TypeError(`${path} exceeds the cumulative causal recording JSON code-unit limit`);
  }
  return value;
};

const consumeNode = (path: string, depth: number, budget: JsonBudget): void => {
  if (depth > CAUSAL_RECORDING_JSON_LIMITS.depth) {
    throw new TypeError(`${path} exceeds the causal recording JSON depth limit`);
  }
  budget.nodes += 1;
  if (budget.nodes > CAUSAL_RECORDING_JSON_LIMITS.nodes) {
    throw new TypeError(`${path} exceeds the causal recording JSON node limit`);
  }
};

const canonicalValue = (value: unknown, path: string, depth: number, budget: JsonBudget): string => {
  consumeNode(path, depth, budget);
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(consumeString(value, path, budget));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)))) {
      throw new TypeError(`${path} must not contain non-index array properties`);
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not contain sparse arrays`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}[${index}] must be an enumerable data value`);
      }
      items.push(canonicalValue(descriptor.value, `${path}[${index}]`, depth + 1, budget));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON-compatible`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }
  const fields: Array<readonly [string, string]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
    consumeString(key, `${path} key`, budget);
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${path}.${key} is not a safe causal recording JSON key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable data value`);
    }
    fields.push([key, canonicalValue(descriptor.value, `${path}.${key}`, depth + 1, budget)]);
  }
  fields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${fields.map(([key, child]) => `${JSON.stringify(key)}:${child}`).join(",")}}`;
};

/** Canonicalizes bounded recording envelopes without applying small dynamics-state ceilings. */
export const canonicalCausalRecordingJson = (value: unknown, path = "recording"): string => {
  const canonical = canonicalValue(value, path, 0, { codeUnits: 0, nodes: 0 });
  if (Buffer.byteLength(canonical, "utf8") > CAUSAL_RECORDING_JSON_LIMITS.document_bytes) {
    throw new TypeError(`${path} exceeds the causal recording JSON document limit`);
  }
  return canonical;
};
