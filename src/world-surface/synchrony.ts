import { DYNAMICS_LIMITS } from "../dynamics/limits.js";

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

const synchronousError = (path: string): TypeError =>
  new TypeError(`${path} must return synchronously`);

const assertSynchronousFunctionPrototype = (
  value: Function,
  path: string
): void => {
  let candidate: object | null = value;
  const visited = new Set<object>();
  let constructorResolved = false;
  for (let depth = 0; candidate !== null; depth += 1) {
    if (depth > DYNAMICS_LIMITS.json_depth || visited.has(candidate)) {
      throw new TypeError(`${path} has an invalid or excessive prototype chain`);
    }
    visited.add(candidate);
    if (candidate === ASYNC_FUNCTION_PROTOTYPE) {
      throw new TypeError(`${path} must be synchronous`);
    }
    if (!constructorResolved) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, "constructor");
      } catch (error) {
        throw new TypeError(`${path}.constructor descriptor cannot be inspected`, {
          cause: error
        });
      }
      if (descriptor && !("value" in descriptor)) {
        throw new TypeError(`${path}.constructor must not be an accessor`);
      }
      if (descriptor) constructorResolved = true;
    }
    try {
      candidate = Object.getPrototypeOf(candidate);
    } catch (error) {
      throw new TypeError(`${path} prototype cannot be inspected`, {
        cause: error
      });
    }
  }
};

const assertNotPromiseLike = (value: unknown, path: string): void => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return;
  }
  let candidate: object | null = value;
  const visited = new Set<object>();
  for (let depth = 0; candidate !== null; depth += 1) {
    if (depth > DYNAMICS_LIMITS.json_depth || visited.has(candidate)) {
      throw new TypeError(`${path} has an invalid or excessive prototype chain`);
    }
    visited.add(candidate);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(candidate, "then");
    } catch (error) {
      throw new TypeError(`${path}.then descriptor cannot be inspected`, {
        cause: error
      });
    }
    if (descriptor) {
      if (!("value" in descriptor)) {
        throw new TypeError(`${path}.then must not be an accessor`);
      }
      if (typeof descriptor.value === "function") throw synchronousError(path);
      return;
    }
    try {
      candidate = Object.getPrototypeOf(candidate);
    } catch (error) {
      throw new TypeError(`${path} prototype cannot be inspected`, {
        cause: error
      });
    }
  }
};

export const callWorldSurfaceSynchronous = <Result>(
  callback: (...args: never[]) => Result,
  argument: unknown,
  path: string
): Result => {
  const result = callback(argument as never);
  assertNotPromiseLike(result, path);
  return result;
};

export const parseWorldSurfaceSynchronousFunction = <
  Callback extends (...args: never[]) => unknown
>(
  value: unknown,
  path: string
): Callback => {
  if (typeof value !== "function") throw new TypeError(`${path} must be a function`);
  assertSynchronousFunctionPrototype(value, path);
  return value as Callback;
};
