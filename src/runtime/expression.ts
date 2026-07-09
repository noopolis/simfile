import { parseDurationSeconds } from "../kernel/duration.js";

type ValueNode = { kind: "number"; value: number } | { kind: "variable"; name: string };
type UnaryNode = { kind: "unary"; operator: "+" | "-"; argument: ExprNode };
type BinaryNode = { kind: "binary"; operator: "+" | "-" | "*" | "/" | "**"; left: ExprNode; right: ExprNode };
type CallNode = { kind: "call"; callee: string; args: ExprNode[] };
type ExprNode = ValueNode | UnaryNode | BinaryNode | CallNode;

type Token = { type: "number" | "identifier" | "operator" | "left-paren" | "right-paren" | "comma" | "eof"; value: string };

type NumberLike = (...args: number[]) => number;
type Arity = { min: number; max: number };

const FUNCTION_ARITY: Record<string, Arity> = {
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  log: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  mod: { min: 2, max: 2 },
  pow: { min: 2, max: 2 },
  min: { min: 2, max: Number.POSITIVE_INFINITY },
  max: { min: 2, max: Number.POSITIVE_INFINITY },
  clamp: { min: 3, max: 3 },
  lerp: { min: 3, max: 3 },
  step: { min: 2, max: 2 },
  smoothstep: { min: 3, max: 3 }
};

const FUNCTIONS: Record<string, NumberLike> = {
  sin: (x) => finite(Math.sin(x)),
  cos: (x) => finite(Math.cos(x)),
  abs: (x) => finite(Math.abs(x)),
  sqrt: (x) => finite(x < 0 ? 0 : Math.sqrt(x)),
  exp: (x) => finite(Math.exp(finite(x))),
  log: (x) => finite(x <= 0 ? 0 : Math.log(x)),
  floor: (x) => finite(Math.floor(x)),
  ceil: (x) => finite(Math.ceil(x)),
  mod: (x, y) => finite(y === 0 ? 0 : x % y),
  pow: (x, y) => finite(Math.pow(x, y)),
  min: (...values) => finite(Math.min(...values)),
  max: (...values) => finite(Math.max(...values)),
  clamp: (value, lo, hi) => finite(Math.max(lo, Math.min(hi, value))),
  lerp: (start, end, step) => finite(start + (end - start) * clamp01(step)),
  step: (edge, value) => finite(value < edge ? 0 : 1),
  smoothstep: (edge0, edge1, value) => {
    if (edge0 === edge1) {
      return 1;
    }
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return finite(t * t * (3 - 2 * t));
  }
};

const RESERVED = new Set(["t", "tick", "pi", "e"]);
const NUMBER = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/u;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_-]*/u;

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

const rewriteDurations = (source: string): string =>
  source.replace(/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:ms|s|m|h|d|w)\b/gu,
    (raw) => String(parseDurationSeconds(raw))
  );

class Lexer {
  private readonly tokens: Token[] = [];
  private cursor = 0;

  public constructor(source: string) {
    let index = 0;
    while (index < source.length) {
      const current = source[index];
      if (/\s/u.test(current)) {
        index += 1;
        continue;
      }

      const remainder = source.slice(index);
      if (remainder.startsWith("**")) {
        this.tokens.push({ type: "operator", value: "**" });
        index += 2;
        continue;
      }

      if (current === "+" || current === "-" || current === "*" || current === "/" || current === "(" || current === ")" || current === ",") {
        this.tokens.push({
          type: current === "(" ? "left-paren" : current === ")" ? "right-paren" : current === "," ? "comma" : "operator",
          value: current
        });
        index += 1;
        continue;
      }

      if (NUMBER.test(remainder)) {
        const matched = remainder.match(/^((?:0|[1-9][0-9]*)(?:\.[0-9]+)?)/u);
        if (!matched) {
          throw new Error(`invalid number token at ${index}`);
        }
        this.tokens.push({ type: "number", value: matched[0] });
        index += matched[0].length;
        continue;
      }

      if (IDENT.test(remainder)) {
        const matched = remainder.match(IDENT);
        if (!matched) {
          throw new Error(`invalid identifier token at ${index}`);
        }
        this.tokens.push({ type: "identifier", value: matched[0] });
        index += matched[0].length;
        continue;
      }

      throw new Error(`unexpected token at ${index}: ${current}`);
    }
    this.tokens.push({ type: "eof", value: "" });
  }

  public peek(offset = 0): Token {
    return this.tokens[this.cursor + offset] ?? { type: "eof", value: "" };
  }

  public advance(): Token {
    const current = this.peek();
    this.cursor += 1;
    return current;
  }

  public match(type: Token["type"], value?: string): boolean {
    const current = this.peek();
    return current.type === type && (value === undefined || current.value === value);
  }

  public consume(type: Token["type"], value?: string): Token {
    if (!this.match(type, value)) {
      const current = this.peek();
      throw new Error(`expected ${value ?? type}, got ${current.type} ${current.value}`);
    }
    return this.advance();
  }
}

class Parser {
  private readonly lexer: Lexer;

  public constructor(source: string) {
    this.lexer = new Lexer(source);
  }

  public parseExpression(): ExprNode {
    return this.parseAdditive();
  }

  public parseRootExpression(): ExprNode {
    const output = this.parseExpression();
    if (!this.lexer.match("eof")) {
      throw new Error(`unexpected token: ${this.lexer.peek().value}`);
    }
    return output;
  }

  private parseAdditive(): ExprNode {
    let node = this.parseMultiplicative();
    while (this.lexer.match("operator", "+") || this.lexer.match("operator", "-")) {
      const operator = this.lexer.advance().value as "+" | "-";
      const right = this.parseMultiplicative();
      node = { kind: "binary", operator, left: node, right };
    }
    return node;
  }

  private parseMultiplicative(): ExprNode {
    let node = this.parseExponent();
    while (this.lexer.match("operator", "*") || this.lexer.match("operator", "/")) {
      const operator = this.lexer.advance().value as "*" | "/";
      const right = this.parseExponent();
      node = { kind: "binary", operator, left: node, right };
    }
    return node;
  }

  private parseExponent(): ExprNode {
    const node = this.parseUnary();
    if (this.lexer.match("operator", "**")) {
      this.lexer.advance();
      const right = this.parseExponent();
      return { kind: "binary", operator: "**", left: node, right };
    }
    return node;
  }

  private parseUnary(): ExprNode {
    if (this.lexer.match("operator", "+") || this.lexer.match("operator", "-")) {
      const operator = this.lexer.advance().value as "+" | "-";
      return { kind: "unary", operator, argument: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    if (this.lexer.match("number")) {
      return { kind: "number", value: Number(this.lexer.advance().value) };
    }

    if (this.lexer.match("identifier")) {
      const token = this.lexer.advance();
      const name = token.value;
      if (this.lexer.match("left-paren")) {
        this.lexer.consume("left-paren");
        const args: ExprNode[] = [];
        if (!this.lexer.match("right-paren")) {
          args.push(this.parseExpression());
          while (this.lexer.match("comma")) {
            this.lexer.consume("comma");
            args.push(this.parseExpression());
          }
        }
        this.lexer.consume("right-paren");
        return { kind: "call", callee: name, args };
      }
      return { kind: "variable", name };
    }

    if (this.lexer.match("left-paren")) {
      this.lexer.consume("left-paren");
      const output = this.parseExpression();
      this.lexer.consume("right-paren");
      return output;
    }

    throw new Error(`unexpected token: ${this.lexer.peek().value}`);
  }
}

const collectDependencies = (node: ExprNode, output: Set<string>): void => {
  if (node.kind === "variable") {
    output.add(node.name);
    return;
  }
  if (node.kind === "unary") {
    collectDependencies(node.argument, output);
    return;
  }
  if (node.kind === "binary") {
    collectDependencies(node.left, output);
    collectDependencies(node.right, output);
    return;
  }
  if (node.kind === "call") {
    node.args.forEach((arg) => collectDependencies(arg, output));
  }
};

const validate = (node: ExprNode): void => {
  if (node.kind === "binary") {
    validate(node.left);
    validate(node.right);
    return;
  }
  if (node.kind === "unary") {
    validate(node.argument);
    return;
  }
  if (node.kind === "call") {
    if (FUNCTION_ARITY[node.callee] === undefined) {
      throw new Error(`unknown function '${node.callee}'`);
    }
    const arity = FUNCTION_ARITY[node.callee];
    if (node.args.length < arity.min || node.args.length > arity.max) {
      throw new Error(`function '${node.callee}' arity mismatch`);
    }
    node.args.forEach(validate);
  }
};

const evaluateNode = (node: ExprNode, variables: Readonly<Record<string, number>>, tick: number, simTime: number): number => {
  if (node.kind === "number") {
    return node.value;
  }
  if (node.kind === "variable") {
    if (node.name === "t") {
      return simTime;
    }
    if (node.name === "tick") {
      return tick;
    }
    if (node.name === "pi") {
      return Math.PI;
    }
    if (node.name === "e") {
      return Math.E;
    }
    return finite(variables[node.name]);
  }
  if (node.kind === "unary") {
    const value = evaluateNode(node.argument, variables, tick, simTime);
    return node.operator === "-" ? -value : value;
  }
  if (node.kind === "binary") {
    const left = evaluateNode(node.left, variables, tick, simTime);
    const right = evaluateNode(node.right, variables, tick, simTime);
    if (node.operator === "+") {
      return left + right;
    }
    if (node.operator === "-") {
      return left - right;
    }
    if (node.operator === "*") {
      return left * right;
    }
    if (node.operator === "/") {
      return right === 0 ? 0 : left / right;
    }
    return finite(Math.pow(left, right));
  }

  const impl = FUNCTIONS[node.callee];
  const args = node.args.map((arg) => evaluateNode(arg, variables, tick, simTime));
  return finite(impl(...args));
};

export interface CompiledExpression {
  source: string;
  dependencies: string[];
  evaluate: (input: { variables: Readonly<Record<string, number>>; tick: number; t: number }) => number;
}

export const compileExpression = (source: string): CompiledExpression => {
  const rewritten = rewriteDurations(source);
  const parser = new Parser(rewritten);
  const ast = parser.parseRootExpression();
  validate(ast);
  const dependencySet = new Set<string>();
  collectDependencies(ast, dependencySet);
  for (const name of dependencySet) {
    if (RESERVED.has(name) || name in FUNCTIONS) {
      dependencySet.delete(name);
    }
  }

  return {
    source: rewritten,
    dependencies: [...dependencySet],
    evaluate: ({ variables, tick, t }) => finite(evaluateNode(ast, variables, tick, t))
  };
};
