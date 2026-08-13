export const WORLD_JSON_LIMITS = Object.freeze({
  request_bytes: 64 * 1024,
  nesting_depth: 32,
});

export type WorldJsonCodecErrorCode = "world_json_invalid" | "world_json_too_large";

const MESSAGES: Readonly<Record<WorldJsonCodecErrorCode, string>> = Object.freeze({
  world_json_invalid: "Invalid world JSON request.",
  world_json_too_large: "World JSON request is too large.",
});

/** Deliberately redacted: syntax positions and request contents never cross the boundary. */
export class WorldJsonCodecError extends Error {
  public readonly code: WorldJsonCodecErrorCode;

  public constructor(code: WorldJsonCodecErrorCode) {
    super(MESSAGES[code]);
    this.name = "WorldJsonCodecError";
    this.code = code;
  }
}

const invalid = (): never => { throw new WorldJsonCodecError("world_json_invalid"); };
const tooLarge = (): never => { throw new WorldJsonCodecError("world_json_too_large"); };
const whitespace = (value: string): boolean => value === " " || value === "\t" || value === "\n" || value === "\r";
const digit = (value: string | undefined): boolean => value !== undefined && value >= "0" && value <= "9";
const hex = (value: string | undefined): boolean => value !== undefined && /^[0-9a-f]$/iu.test(value);

class JsonScanner {
  private index = 0;

  public constructor(private readonly source: string) {}

  public scan(): void {
    this.space();
    this.value(0);
    this.space();
    if (this.index !== this.source.length) invalid();
  }

  private space(): void {
    while (whitespace(this.source[this.index] ?? "")) this.index += 1;
  }

  private value(depth: number): void {
    if (depth > WORLD_JSON_LIMITS.nesting_depth) invalid();
    const current = this.source[this.index];
    if (current === "{") this.object(depth);
    else if (current === "[") this.array(depth);
    else if (current === "\"") this.string();
    else if (current === "-" || digit(current)) this.number();
    else if (this.source.startsWith("true", this.index)) this.index += 4;
    else if (this.source.startsWith("false", this.index)) this.index += 5;
    else if (this.source.startsWith("null", this.index)) this.index += 4;
    else invalid();
  }

  private object(depth: number): void {
    this.index += 1;
    this.space();
    if (this.source[this.index] === "}") { this.index += 1; return; }
    const keys = new Set<string>();
    while (true) {
      if (this.source[this.index] !== "\"") invalid();
      const key = this.string();
      if (keys.has(key)) invalid();
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ":") invalid();
      this.index += 1;
      this.space();
      this.value(depth + 1);
      this.space();
      const delimiter = this.source[this.index];
      if (delimiter === "}") { this.index += 1; return; }
      if (delimiter !== ",") invalid();
      this.index += 1;
      this.space();
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.space();
    if (this.source[this.index] === "]") { this.index += 1; return; }
    while (true) {
      this.value(depth + 1);
      this.space();
      const delimiter = this.source[this.index];
      if (delimiter === "]") { this.index += 1; return; }
      if (delimiter !== ",") invalid();
      this.index += 1;
      this.space();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const current = this.source[this.index]!;
      if (current === "\"") {
        this.index += 1;
        try { return JSON.parse(this.source.slice(start, this.index)) as string; } catch { return invalid(); }
      }
      if (current.charCodeAt(0) <= 0x1f) invalid();
      if (current === "\\") {
        this.index += 1;
        const escaped = this.source[this.index];
        if (escaped === "u") {
          for (let offset = 1; offset <= 4; offset += 1) if (!hex(this.source[this.index + offset])) invalid();
          this.index += 5;
          continue;
        }
        if (escaped === undefined || !"\"\\/bfnrt".includes(escaped)) invalid();
      }
      this.index += 1;
    }
    return invalid();
  }

  private number(): void {
    if (this.source[this.index] === "-") this.index += 1;
    if (this.source[this.index] === "0") this.index += 1;
    else {
      const first = this.source[this.index];
      if (first === undefined || first < "1" || first > "9") invalid();
      while (digit(this.source[++this.index])) { /* scan integer */ }
    }
    if (this.source[this.index] === ".") {
      this.index += 1;
      if (!digit(this.source[this.index])) invalid();
      while (digit(this.source[this.index])) this.index += 1;
    }
    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") this.index += 1;
      if (!digit(this.source[this.index])) invalid();
      while (digit(this.source[this.index])) this.index += 1;
    }
  }
}

const copyBytes = (input: unknown, maximum: number): Uint8Array => {
  try {
    if (!(input instanceof Uint8Array)) return invalid();
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > WORLD_JSON_LIMITS.request_bytes) return invalid();
    if (input.byteLength > maximum) return tooLarge();
    if (input.byteLength === 0) return invalid();
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  } catch (error) {
    if (error instanceof WorldJsonCodecError) throw error;
    return invalid();
  }
};

/** Parses exactly one bounded JSON value and rejects duplicate decoded object keys. */
export const parseWorldJson = (input: unknown, maximum = WORLD_JSON_LIMITS.request_bytes): unknown => {
  const bytes = copyBytes(input, maximum);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid(); }
  new JsonScanner(source).scan();
  try { return JSON.parse(source) as unknown; } catch { return invalid(); }
};
