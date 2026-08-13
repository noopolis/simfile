import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDistRoot = resolve(packageRoot, "web", "dist");
const webSourceRoot = resolve(packageRoot, "web");
const webRoot = existsSync(resolve(webDistRoot, "index.html"))
  ? webDistRoot
  : webSourceRoot;

const safeJoin = (base: string, target: string): string => {
  const absolute = resolve(base, target);
  const rel = relative(base, absolute);
  if (rel.startsWith("..") || rel.includes("../")) {
    throw new Error("Invalid path");
  }
  return absolute;
};

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`));
};

export const streamViewerFile = async (
  res: ServerResponse,
  requestedPath: string,
): Promise<void> => {
  try {
    const path = safeJoin(webRoot, requestedPath);
    await access(path);
    const details = await stat(path);
    if (details.isDirectory()) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    const contentType = mimeTypes[extname(path)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
};

export const streamViewerExtensionFile = async (
  res: ServerResponse,
  root: string,
  requestedPath: string,
  expectedSha256: string,
): Promise<void> => {
  try {
    const candidate = safeJoin(root, requestedPath);
    const actual = await realpath(candidate);
    if (!inside(root, actual)) throw new Error("Invalid path");
    const details = await stat(actual);
    if (!details.isFile()) throw new Error("Invalid path");
    const bytes = await readFile(actual);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Viewer extension content identity changed");
      return;
    }
    const contentType = mimeTypes[extname(actual)] || "application/octet-stream";
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    res.end(bytes);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
};
