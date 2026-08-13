import path from "node:path";

const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Exact portable runtime-root grammar shared by the bundle and launcher. */
export const parseWorldSidecarAbsolutePath = (value: unknown): string => {
  if (typeof value !== "string" || value.length < 2 || value.length > 4096 || CONTROL.test(value)
    || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError("invalid world sidecar path");
  }
  const parsed = path.parse(value);
  if (value === parsed.root) throw new TypeError("invalid world sidecar path");
  const relative = value.slice(parsed.root.length);
  const segments = relative.split(path.sep);
  if (segments.length === 0 || new Set(segments).size !== segments.length
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("invalid world sidecar path");
  }
  return value;
};
